import { Pressable, StyleSheet, Text, View } from "react-native";
import { HotelCard, MetricCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../../theme/colors";

export function RevenueSnapshotCard(props: { onNavigate?: (route: string) => void }) {
  return (
    <HotelCard title="Revenue Snapshot" subtitle="Forecast, pickup and pending commercial actions">
      <View style={styles.metrics}>
        <MetricCard label="Occ forecast" value="89%" detail="Weekend" tone="success" />
        <MetricCard label="ADR" value="EUR 142" detail="Forecast" tone="ai" />
        <MetricCard label="RevPAR" value="EUR 126" detail="Projected" tone="info" />
        <MetricCard label="Pickup 24h" value="+18" detail="room nights" tone="warning" />
      </View>
      <View style={styles.alertRow}>
        <StatusChip label="3 recommendations" tone="warning" />
        <Text style={styles.alertText}>Booking.com mock failed last sync; parity alert needs review.</Text>
      </View>
      <View style={styles.actions}>
        <SnapshotButton label="Open Revenue" route="RevenueHome" onNavigate={props.onNavigate} />
        <SnapshotButton label="History & Forecast" route="RevenueHistoryForecast" onNavigate={props.onNavigate} />
        <SnapshotButton label="View Recommendations" route="RevenueRecommendations" onNavigate={props.onNavigate} />
      </View>
    </HotelCard>
  );
}

function SnapshotButton(props: { label: string; route: string; onNavigate?: (route: string) => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={() => props.onNavigate?.(props.route)} style={styles.button}>
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  alertRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap"
  },
  alertText: {
    color: colors.muted,
    flex: 1,
    minWidth: 160,
    lineHeight: 20,
    letterSpacing: 0
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  button: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: colors.primary,
    justifyContent: "center",
    paddingHorizontal: 12
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "900",
    letterSpacing: 0
  }
});
