import { ScrollView, StyleSheet, Text, View } from "react-native";
import { HotelCard, MetricCard, StatusChip, TimelineDataGrid } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function BackOfficeSetupScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.kicker}>Back Office</Text>
        <Text style={styles.title}>Hotel setup</Text>
      </View>
      <View style={styles.grid}>
        <MetricCard label="Setup progress" value="72%" tone="warning" />
        <MetricCard label="Rooms mapped" value="2" tone="success" />
        <MetricCard label="Go-live blockers" value="2" tone="error" />
      </View>
      <HotelCard title="Recommended next action" subtitle="Mobile summary of Back Office readiness">
        <Text style={styles.body}>Configure Billing Settings and SES.HOSPEDAJES credentials in admin-web before go-live.</Text>
        <View style={styles.row}>
          <StatusChip label="Invoice sequence missing" tone="error" />
          <StatusChip label="OCR provider missing" tone="warning" />
        </View>
      </HotelCard>
      <HotelCard title="Setup track" subtitle="What still blocks production">
        <TimelineDataGrid
          items={[
            { label: "Property map", value: "review" },
            { label: "Billing", value: "blocked" },
            { label: "Compliance", value: "blocked" },
            { label: "AI Check-in", value: "needs OCR" }
          ]}
        />
      </HotelCard>
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
  },
  grid: {
    gap: 10
  },
  body: {
    color: colors.muted,
    lineHeight: 20
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  }
});
