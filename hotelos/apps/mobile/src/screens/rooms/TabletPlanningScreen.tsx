import { ScrollView, StyleSheet, Text, View } from "react-native";
import { HotelCard, RateGridCell, RoomOperationalCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";
import { planningDates, planningRooms } from "./roomPlanningData";

export function TabletPlanningScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>Timeline</Text>
          <Text style={styles.title}>Tablet planning</Text>
        </View>
        <StatusChip label="AI sidebar ready" tone="ai" />
      </View>

      <View style={styles.planningGrid}>
        <HotelCard title="Rooms">
          {planningRooms.map((room) => (
            <RoomOperationalCard key={room.roomNumber} {...room} />
          ))}
        </HotelCard>
        <HotelCard title="Rooms x dates" subtitle="Room moves require confirmation before applying">
          <View style={styles.rateGrid}>
            {planningRooms.flatMap((room) =>
              planningDates.map((date) => (
                <RateGridCell
                  key={`${room.roomNumber}-${date}`}
                  date={`${room.roomNumber} / ${date}`}
                  price={room.roomNumber === "432" && date === "May 14" ? "RES-18392" : room.maintenance === "blocked" ? "Blocked" : "Available"}
                  restriction={room.maintenance === "blocked" ? "No assignment" : "Tap for detail"}
                  selected={room.roomNumber === "432" && date === "May 14"}
                />
              ))
            )}
          </View>
        </HotelCard>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12
  },
  planningGrid: {
    gap: 12
  },
  rateGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
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
  }
});
