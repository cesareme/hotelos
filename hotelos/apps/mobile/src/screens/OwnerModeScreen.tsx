import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Landmark } from "lucide-react-native";
import { MetricTile } from "../components/MetricTile";
import { getOwnerSnapshot, type MobileOwnerSnapshot } from "../services/api";
import { colors } from "../theme/colors";

export function OwnerModeScreen() {
  const [snapshot, setSnapshot] = useState<MobileOwnerSnapshot | null>(null);

  useEffect(() => {
    void getOwnerSnapshot().then(setSnapshot);
  }, []);

  const data =
    snapshot ??
    ({
      occupancy: 0,
      adr: 0,
      revpar: 0,
      cashCollected: 0,
      debtors: 0,
      maintenanceCost: 0,
      roomsBlocked: 0,
      capexProjects: 0,
      complianceIssues: 0,
      aiOwnerBriefing: "Loading owner briefing."
    } as MobileOwnerSnapshot);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Owner mode</Text>
          <Text style={styles.title}>Portfolio</Text>
        </View>
        <Landmark color={colors.primary} size={28} />
      </View>

      <View style={styles.metricGrid}>
        <MetricTile label="Occupancy" value={`${data.occupancy}%`} tone="success" />
        <MetricTile label="ADR" value={`${data.adr} EUR`} />
        <MetricTile label="RevPAR" value={`${data.revpar} EUR`} />
        <MetricTile label="Cash collected" value={`${data.cashCollected} EUR`} tone="success" />
        <MetricTile label="Debtors" value={`${data.debtors} EUR`} tone="warning" />
        <MetricTile label="Blocked rooms" value={data.roomsBlocked} tone="danger" />
        <MetricTile label="Maintenance cost" value={`${data.maintenanceCost} EUR`} />
        <MetricTile label="Capex projects" value={data.capexProjects} />
      </View>

      <View style={styles.briefing}>
        <Text style={styles.briefingTitle}>AI owner briefing</Text>
        <Text style={styles.briefingText}>
          {data.aiOwnerBriefing}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 18
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  kicker: {
    color: colors.muted,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 12
  },
  briefing: {
    backgroundColor: "#edf5f3",
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding: 16
  },
  briefingTitle: {
    color: colors.primaryDark,
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 0
  },
  briefingText: {
    marginTop: 6,
    color: colors.ink,
    lineHeight: 23,
    fontSize: 16,
    letterSpacing: 0
  }
});
