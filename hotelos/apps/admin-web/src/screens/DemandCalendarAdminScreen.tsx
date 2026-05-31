import { ScreenScaffold } from "./ScreenScaffold";

export function DemandCalendarAdminScreen() {
  return (
    <ScreenScaffold
      eyebrow="Demand"
      title="Demand Calendar Admin"
      summary="Manage events, compression periods, holidays, market movement and demand drivers used in forecasts and pricing explanations."
      cards={[
        { title: "Madrid design congress", metric: "High impact", status: "ok", body: "Expected compression feeds forecast confidence and rate recommendations." },
        { title: "Manual event creation", status: "ok", body: "Event creation writes DemandCalendarEventCreated audit events." }
      ]}
    />
  );
}
