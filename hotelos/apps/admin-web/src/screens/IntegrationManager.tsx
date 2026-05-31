import { ScreenScaffold } from "./ScreenScaffold";

export function IntegrationManager() {
  return (
    <ScreenScaffold
      eyebrow="Marketplace"
      title="Integration Manager"
      summary="Browse integration categories, connect providers through secret references, test connections and inspect integration logs."
      cards={[
        { title: "Payment Gateways", status: "ok", body: "Demo gateway connected with credentials stored as a secret reference." },
        { title: "Government connectors", status: "warn", body: "SES.HOSPEDAJES credentials must be configured before go-live." }
      ]}
    />
  );
}
