import { ScrollView, StyleSheet, Text, View } from "react-native";
import { RoomCard, StatusChip, TimelineDataGrid } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const rooms = [
  {
    roomNumber: "432",
    status: "inspected",
    detail: "Next arrival: Maria Lopez, 15:00. Balance: EUR 0. Guest register: signature pending."
  },
  {
    roomNumber: "108",
    status: "out_of_order",
    detail: "Blocked by maintenance until tomorrow. Bathroom leak work order open."
  },
  {
    roomNumber: "204",
    status: "dirty",
    detail: "Departure clean pending. Manager override required before assignment."
  }
];

export function MobilePlanningScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.kicker}>Timeline</Text>
        <Text style={styles.title}>Mobile planning</Text>
      </View>
      <TimelineDataGrid
        items={[
          { label: "Ready", value: "41" },
          { label: "Dirty", value: "9" },
          { label: "Blocked", value: "2" }
        ]}
      />
      {rooms.map((room) => (
        <RoomCard
          key={room.roomNumber}
          roomNumber={room.roomNumber}
          status={room.status}
          detail={room.detail}
          actions={
            <>
              <StatusChip label="Check-in" tone="ai" />
              <StatusChip label="Move" tone="neutral" />
              <StatusChip label="Block" tone="warning" />
              <StatusChip label="Message" tone="success" />
            </>
          }
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  kicker: {
    color: colors.muted,
    fontWeight: "800",
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 0
  }
});
