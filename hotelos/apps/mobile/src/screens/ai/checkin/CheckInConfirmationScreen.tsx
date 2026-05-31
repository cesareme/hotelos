import { Text } from "react-native";
import { ConfirmationCard, HotelCard, StatusChip } from "@hotelos/ui";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";
import { checkInExecutionActions, checkInGuest } from "./checkInFlowData";

export function CheckInConfirmationScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="confirm"
      title="Confirm check-in"
      subtitle="The receptionist sees exactly what will change before tools execute."
      stateLabel="confirmation required"
    >
      <ConfirmationCard
        title="Confirm check-in"
        summary={`Ready to check in ${checkInGuest.name} to room ${checkInGuest.roomNumber}.`}
        riskLevel="high"
        warnings={["Phone number is missing. Ask guest before confirming.", "Guest register signature is required."]}
        requiredApprovals={["Receptionist confirmation", "Guest signature"]}
        actions={checkInExecutionActions}
        primaryActionLabel="Confirm check-in"
        secondaryActionLabel="Cancel"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
      <HotelCard title="Compliance impact">
        <Text>Guest register record will be created or updated.</Text>
        <Text>SES.HOSPEDAJES submission will be queued after signature.</Text>
        <StatusChip label="ID image already discarded" tone="success" />
      </HotelCard>
    </CheckInFlowScaffold>
  );
}
