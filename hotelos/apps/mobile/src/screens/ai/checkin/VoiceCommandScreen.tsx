import { Text, View } from "react-native";
import { CommandDock, HotelCard, RiskBadge, StatusChip } from "@hotelos/ui";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";

export function VoiceCommandScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="voice"
      title="Voice command"
      subtitle="Reception starts the flow by saying: Check in this customer in room 432."
      stateLabel="listening"
    >
      <CommandDock
        value="Check in this customer in room 432"
        onChangeText={() => undefined}
        onSubmit={() => undefined}
        onVoice={() => undefined}
        state="Listening to receptionist command"
        confidence={94}
        riskLevel="high"
      />
      <HotelCard title="Interpreted intent" subtitle="The AI previews the operation before any backend tool executes" tone="ai">
        <View>
          <Text>Intent: CHECK_IN_GUEST</Text>
          <Text>Entities: room_number = 432, source = voice</Text>
          <Text>Required tools: scanDocument, matchGuestToReservation, validateRoomAssignment</Text>
        </View>
        <RiskBadge riskLevel="high" />
        <StatusChip label="Confirmation required" tone="warning" />
      </HotelCard>
    </CheckInFlowScaffold>
  );
}
