import { Text, View } from "react-native";
import { ActionDrawer, BottomSheet, ConfirmationCard, StatusChip, TimelineDataGrid } from "@hotelos/ui";
import { planningRooms } from "./roomPlanningData";

const room = planningRooms[0];

export function RoomDetailBottomSheet() {
  return (
    <BottomSheet title={`Room ${room.roomNumber}`}>
      <TimelineDataGrid
        items={[
          { label: "Room type", value: room.roomType },
          { label: "Housekeeping", value: room.housekeeping },
          { label: "Maintenance", value: room.maintenance },
          { label: "Register", value: room.complianceState }
        ]}
      />
      <Text>{room.nextBestAction}</Text>
      <View>
        <StatusChip label="Current guest: none" tone="success" />
        <StatusChip label={`Next arrival: ${room.nextArrival}`} tone="ai" />
      </View>
      <ActionDrawer
        title="Quick actions"
        actions={[
          { label: "Check-in", onPress: () => undefined },
          { label: "Move", onPress: () => undefined },
          { label: "Block", onPress: () => undefined },
          { label: "Clean", onPress: () => undefined },
          { label: "Maintenance", onPress: () => undefined },
          { label: "Message", onPress: () => undefined }
        ]}
      />
      <ConfirmationCard
        title="Room block requires confirmation"
        summary="Blocking room 432 removes it from sellable inventory and creates an audit event."
        riskLevel="high"
        warnings={["Room blocks affect availability and connected channels."]}
        requiredApprovals={["Manager or maintenance lead"]}
        actions={["Create room block", "Update inventory", "Write audit event"]}
        primaryActionLabel="Confirm room block"
        secondaryActionLabel="Cancel"
        onConfirm={() => undefined}
        onCancel={() => undefined}
        disabled
      />
    </BottomSheet>
  );
}
