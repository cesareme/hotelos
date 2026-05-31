import { Text } from "react-native";
import { HotelCard, RoomOperationalCard, StatusChip, TimelineDataGrid } from "@hotelos/ui";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";
import { checkInGuest } from "./checkInFlowData";

export function RoomValidationScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="validate"
      title="Room validation"
      subtitle="Inventory, housekeeping, maintenance and overlap checks run before the confirmation card."
      stateLabel="validated"
    >
      <RoomOperationalCard
        roomNumber={checkInGuest.roomNumber}
        roomType="Double Standard"
        occupancy="vacant"
        housekeeping="inspected"
        maintenance="clear"
        nextArrival={checkInGuest.name}
        balance={checkInGuest.balance}
        complianceState="signature pending"
        nextBestAction="Ask for phone number, collect signature, then confirm check-in."
      />
      <HotelCard title="Validation result">
        <TimelineDataGrid
          items={[
            { label: "Sellable", value: "true" },
            { label: "Maintenance block", value: "false" },
            { label: "Overlap", value: "none" },
            { label: "Dirty override", value: "not needed" }
          ]}
        />
        <StatusChip label="canAssignRoom: allowed" tone="success" />
        <Text>Blocked rooms and dirty rooms require manager override and a separate confirmation.</Text>
      </HotelCard>
    </CheckInFlowScaffold>
  );
}
