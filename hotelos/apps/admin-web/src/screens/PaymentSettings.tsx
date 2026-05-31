import { ScreenScaffold } from "./ScreenScaffold";

export function PaymentSettings() {
  return (
    <ScreenScaffold
      eyebrow="Payment Vault"
      title="Payment Settings"
      summary="Configure PSP adapters, payment links, tokenization, SCA/3DS, deposits, no-show charges, OTA virtual cards and refund approvals."
      cards={[
        {
          title: "Provider status",
          status: "ok",
          body: "Demo payment provider is connected through Integration Marketplace.",
          actions: [{ label: "Integration marketplace", screen: "IntegrationMarketplaceHome" }]
        },
        {
          title: "Refund policy",
          status: "warn",
          body: "Refunds require manager approval and never store raw card data.",
          actions: [{ label: "Users & roles", screen: "UserRoleManager" }]
        }
      ]}
    />
  );
}
