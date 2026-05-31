import { ScreenScaffold } from "./ScreenScaffold";

export function AISettings() {
  return (
    <ScreenScaffold
      eyebrow="AI governance"
      title="AI Settings"
      summary="Configure AI enablement, allowed tools, automation level by department, confirmations, disclosure, languages, knowledge base and escalation rules."
      cards={[
        {
          title: "Automation level",
          status: "ok",
          body: "Default automation is suggest_and_confirm. High-risk tools require confirmation.",
          actions: [{ label: "AI governance policies", screen: "AIGovernanceSettings" }]
        },
        {
          title: "ID image policy",
          status: "ok",
          body: "Document image retention is discard_after_ocr. Raw ID images cannot be stored by default.",
          actions: [{ label: "Retention settings", screen: "GuestRegisterRetentionSettings" }]
        },
        {
          title: "AI Setup Assistant",
          status: "warn",
          body: "Preview before apply for bulk room creation, housekeeping sections, templates, module readiness and go-live review.",
          actions: [
            { label: "AI Setup Center", screen: "AISetupCenter" },
            { label: "AI tool registry", screen: "AIToolRegistry" }
          ]
        }
      ]}
    />
  );
}
