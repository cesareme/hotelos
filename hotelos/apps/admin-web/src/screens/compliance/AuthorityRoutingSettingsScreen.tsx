import { ScreenScaffold } from "../ScreenScaffold";

export function AuthorityRoutingSettingsScreen() {
  return (
    <ScreenScaffold
      eyebrow="Territorial routing"
      title="Authority Routing Settings"
      summary="Route Spanish lodging communications to SES.HOSPEDAJES by default, with configurable regional adapters such as Catalonia/Mossos and placeholders for other authorities."
      cards={[
        { title: "Default Spain", status: "ok", body: "Properties in Spain route to SES.HOSPEDAJES unless a higher-priority regional rule overrides it." },
        { title: "Catalonia", status: "warn", body: "Mossos routing is available as a placeholder adapter and must be legally reviewed before production use." },
        { title: "Override controls", status: "ok", body: "Back Office can configure country, region, priority, activity type and authority-specific payload settings per property." }
      ]}
    />
  );
}
