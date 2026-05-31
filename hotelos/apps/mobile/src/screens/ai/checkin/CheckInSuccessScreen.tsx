import { Text } from "react-native";
import { AuditTrailPanel, HotelCard, StatusChip, TimelineDataGrid } from "@hotelos/ui";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";
import { checkInAuditEvents, checkInGuest } from "./checkInFlowData";

export function CheckInSuccessScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="success"
      title="Check-in complete"
      subtitle="The room is occupied, compliance is queued, and the full action chain is auditable."
      stateLabel="complete"
    >
      <HotelCard title="Outcome" subtitle={`${checkInGuest.name} is now in-house`} tone="ai">
        <TimelineDataGrid
          items={[
            { label: "Reservation", value: "checked_in" },
            { label: "Room 432", value: "occupied" },
            { label: "Compliance", value: "queued" },
            { label: "Welcome", value: "sent" }
          ]}
        />
        <StatusChip label="SES.HOSPEDAJES queued" tone="success" />
        <StatusChip label="Audit chain sealed" tone="success" />
        <Text>ID document image was not stored.</Text>
      </HotelCard>
      <AuditTrailPanel events={checkInAuditEvents} />
    </CheckInFlowScaffold>
  );
}
