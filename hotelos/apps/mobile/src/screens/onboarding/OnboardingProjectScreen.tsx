import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const sourceFiles = [
  ["room_list.csv", "room_list", "88%"],
  ["rate_sheet.xlsx", "rate_sheet", "81%"],
  ["future_reservations.csv", "reservation_export", "79%"],
  ["history_forecast_may_2026.xlsx", "revenue_history_forecast_report", "91%"],
  ["floor_plan_main.pdf", "floor_plan", "64%"]
];

export function OnboardingProjectScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <StatusChip label="review required" tone="warning" />
        <Text style={styles.title}>HotelOS Demo Onboarding Project</Text>
        <Text style={styles.body}>Source: Generic PMS exports. Target go-live: 1 Jun 2026. AI has generated a proposed blueprint, mappings and dry-run preview, but human review is still mandatory.</Text>
      </View>
      <View style={styles.metricRow}>
        <Metric label="Progress" value="62%" />
        <Metric label="Confidence" value="84%" />
        <Metric label="Blocking" value="2" />
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Uploaded and classified files</Text>
        {sourceFiles.map(([name, type, confidence]) => (
          <View key={name} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{name}</Text>
              <Text style={styles.body}>{type}</Text>
            </View>
            <StatusChip label={confidence} tone={type === "floor_plan" ? "warning" : "success"} />
          </View>
        ))}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Review property blueprint" onPress={() => props.onNavigate?.("PropertyBlueprintPreview")} style={styles.navCard}>
        <Text style={styles.cardTitle}>Property Blueprint Review</Text>
        <Text style={styles.body}>1 building, 4 floors, 70 rooms, 4 room types, restaurant, parking, meeting room and rooftop.</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Review pending mappings" onPress={() => props.onNavigate?.("MigrationReview")} style={styles.navCard}>
        <Text style={styles.cardTitle}>Migration Review</Text>
        <Text style={styles.body}>Approve low-risk room mappings and review revenue history totals before dry-run.</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Open go-live readiness" onPress={() => props.onNavigate?.("GoLiveReadiness")} style={styles.navCard}>
        <Text style={styles.cardTitle}>Go-Live Readiness</Text>
        <Text style={styles.body}>Readiness score, blocking issues, cutover stages and rollback plan.</Text>
      </Pressable>
    </ScrollView>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{props.value}</Text>
      <Text style={styles.metricLabel}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  header: { gap: 8 },
  title: { color: colors.ink, fontSize: 30, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  metricRow: { flexDirection: "row", gap: 10 },
  metric: { flex: 1, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 12 },
  metricValue: { color: colors.ink, fontSize: 24, fontWeight: "900", letterSpacing: 0 },
  metricLabel: { color: colors.muted, fontWeight: "800", letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
  navCard: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10 },
  rowTitle: { color: colors.ink, fontWeight: "900", letterSpacing: 0 }
});
