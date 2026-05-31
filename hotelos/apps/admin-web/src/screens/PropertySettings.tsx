import { ScreenScaffold } from "./ScreenScaffold";

export function PropertySettings() {
  return (
    <ScreenScaffold
      eyebrow="Property profile"
      title="Property Settings"
      summary="Configure property legal details, address, municipality, province, timezone, tax region and operational defaults."
      cards={[
        { title: "Legal details", status: "ok", body: "Legal name, address, municipality, province, timezone and tax region are part of readiness." },
        { title: "Operating policy", status: "warn", body: "Default check-in, checkout, room inventory and guest register policies are configured here." }
      ]}
    />
  );
}
