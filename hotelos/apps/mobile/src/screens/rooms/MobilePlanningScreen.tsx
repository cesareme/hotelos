import { ScrollView, StyleSheet, Text, View } from "react-native";
import { HotelCard, RoomOperationalCard, StatusChip, TimelineDataGrid } from "@hotelos/ui";
import { colors } from "../../theme/colors";
import { RoomDetailBottomSheet } from "./RoomDetailBottomSheet";
import { planningRooms, roomFilters } from "./roomPlanningData";

export function MobilePlanningScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.kicker}>Timeline</Text>
        <Text style={styles.title}>Mobile planning</Text>
        <Text style={styles.subtitle}>Room state, guest state and next action are visible before opening details.</Text>
      </View>

      <View style={styles.filters}>
        {roomFilters.map((filter) => (
          <StatusChip key={filter} label={filter} tone={filter === "Blocked" ? "error" : filter === "Compliance pending" ? "warning" : "neutral"} compact />
        ))}
      </View>

      <TimelineDataGrid
        items={[
          { label: "Ready", value: "41" },
          { label: "Dirty", value: "9" },
          { label: "Blocked", value: "2" },
          { label: "Arrival risk", value: "4 rooms" }
        ]}
      />

      <HotelCard title="AI next actions" subtitle="Context-aware suggestions for the room board" tone="ai">
        <Text style={styles.nextAction}>Show clean inspected rooms for arrivals before 15:00.</Text>
        <Text style={styles.nextAction}>Assign the best available room to Garcia.</Text>
        <Text style={styles.nextAction}>Block room 108 until tomorrow after manager confirmation.</Text>
      </HotelCard>

      {planningRooms.map((room) => (
        <RoomOperationalCard key={room.roomNumber} {...room} />
      ))}

      <RoomDetailBottomSheet />
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
    fontWeight: "900",
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 0
  },
  subtitle: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  filters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  nextAction: {
    color: colors.primary,
    fontWeight: "900",
    lineHeight: 20,
    letterSpacing: 0
  }
});
