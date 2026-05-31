import { ScreenScaffold } from "./ScreenScaffold";

export function OrganizationSettings() {
  return (
    <ScreenScaffold
      eyebrow="Legal entity"
      title="Organization Settings"
      summary="Configure organization identity, legal name, tax ID, security defaults and multi-property governance."
      cards={[
        {
          title: "Legal profile",
          status: "ok",
          body: "Organization name, legal name, country and tax ID are stored centrally.",
          actions: [{ label: "Open property profile setup", screen: "PropertyProfileSetupForm" }]
        },
        {
          title: "Security defaults",
          status: "warn",
          body: "MFA is required for owners, managers, accountants and admins.",
          actions: [{ label: "Users & roles", screen: "UserRoleManager" }]
        }
      ]}
    />
  );
}
