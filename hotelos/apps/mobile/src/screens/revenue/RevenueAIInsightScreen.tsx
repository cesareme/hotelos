import { RevenueScaffold } from "./RevenueScaffold";

export function RevenueAIInsightScreen() {
  return (
    <RevenueScaffold
      eyebrow="AI Revenue Copilot"
      title="Explain the next best action"
      summary="AI can analyze, recommend, simulate and explain. It cannot apply high-impact revenue or channel changes without permission and confirmation."
      metrics={[
        { label: "Intent", value: "analyzeRateParity", detail: "Confidence 91%" },
        { label: "Risk", value: "High", detail: "Confirmation needed" },
        { label: "Sources", value: "5", detail: "PMS, rates, channels, comp set, events" }
      ]}
      cards={[
        { title: "Suggested command", status: "ready", body: "Which dates are underpriced next month? Show me parity issues. Simulate raising double rooms by 8% next Friday." },
        { title: "Safety rule", status: "enforced", body: "AI tools validate module enabled state, permissions, data quality, risk level, channel health and automation constraints." }
      ]}
    />
  );
}
