import { ScreenScaffold } from "./ScreenScaffold";

export function RevenueAutomationRulesScreen() {
  return (
    <ScreenScaffold
      eyebrow="Automation"
      title="Revenue Automation Rules"
      summary="Automation supports manual-only, recommend-only, approve-required and low-risk auto-apply within strict limits."
      cards={[
        { title: "Low-risk weekday rule", status: "ok", body: "Auto-apply only within limits, confidence threshold and healthy channel sync." },
        { title: "Never close direct", status: "ok", body: "Direct booking engine is protected from automated closeout." },
        { title: "Blocked automation", status: "warn", body: "Expedia sync health blocks restriction auto-apply until credentials are repaired." }
      ]}
    />
  );
}
