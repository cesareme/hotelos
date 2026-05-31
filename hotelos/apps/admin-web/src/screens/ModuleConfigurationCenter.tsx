import { ScreenScaffold } from "./ScreenScaffold";

export function ModuleConfigurationCenter() {
  return (
    <ScreenScaffold
      eyebrow="Module setup"
      title="Module Configuration Center"
      summary="Every module declares required setup, configuration schema, connected integrations, permission needs and recommended next action."
      cards={[
        { title: "AI Check-in", status: "error", body: "Requires room inventory, signature template, OCR provider and SES.HOSPEDAJES configuration." },
        { title: "Payment Vault", status: "ok", body: "Payment gateway is connected through a secret reference, not plaintext credentials." }
      ]}
    />
  );
}
