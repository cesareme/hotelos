import { RevenueScaffold } from "./RevenueScaffold";

export function ScenarioSimulatorScreen() {
  return (
    <RevenueScaffold
      eyebrow="Scenario Simulator"
      title="What-if pricing"
      summary="Simulate rate changes, channel closeout, restrictions, discounts and group displacement before applying anything."
      metrics={[
        { label: "ADR change", value: "+EUR 12.30", detail: "Raise double rooms 8%" },
        { label: "RevPAR change", value: "+EUR 8.80", detail: "Low occupancy risk" },
        { label: "Profit change", value: "+EUR 710", detail: "Medium confidence" }
      ]}
      cards={[
        { title: "Saturday +8% scenario", status: "medium risk", body: "Expected occupancy change -2pp, direct share +2pp, profit lift EUR 710. Apply requires confirmation." }
      ]}
    />
  );
}
