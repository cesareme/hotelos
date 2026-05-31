import { ScreenScaffold } from "./ScreenScaffold";

export function DepartmentManager() {
  return (
    <ScreenScaffold
      eyebrow="Teams"
      title="Department Manager"
      summary="Configure departments, user assignment, housekeeping sections, maintenance areas and operating rules."
      cards={[
        { title: "Base departments", status: "ok", body: "Reception, Housekeeping, Maintenance, Management, Accounting, Revenue, Concierge, Restaurant, Bar, Spa, Security, Events and IT." },
        { title: "Housekeeping configuration", status: "ok", body: "Create sections, assign rooms by floor or zone, and store rules for stayover, departure, linen, minibar and supervisor approval." },
        { title: "Maintenance configuration", status: "ok", body: "Create maintenance areas, assign rooms, and store rules for priority, SLA, room blocking, contractors and warranty tracking." }
      ]}
    />
  );
}
