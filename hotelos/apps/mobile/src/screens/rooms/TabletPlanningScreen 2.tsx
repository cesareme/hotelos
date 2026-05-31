import { ScrollView, StyleSheet, Text, View } from "react-native";
import { RateGridCell, RoomCard } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function TabletPlanningScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.kicker}>Timeline</Text>
        <Text style={styles.title}>Tablet planning</Text>
      </View>
      <View style={styles.grid}>
        <RoomCard roomNumber="432" status="inspected" detail="RES-18392, May 14-16" />
        <RateGridCell date="May 15" price="RES-18392" restriction="Tap for detail" />
        <RateGridCell date="May 16" price="Available" restriction="AI sidebar ready" />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  grid: {
    gap: 10
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
