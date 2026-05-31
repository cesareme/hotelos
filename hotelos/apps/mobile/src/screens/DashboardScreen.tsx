import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { DashboardSnapshot } from "@hotelos/shared";
import { ShieldCheck } from "lucide-react-native";
import { MetricTile } from "../components/MetricTile";
import { getDashboardSnapshot } from "../services/api";
import { colors } from "../theme/colors";

export function DashboardScreen() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);

  useEffect(() => {
    void getDashboardSnapshot().then(setSnapshot);
  }, []);

  const data =
    snapshot ??
    ({
      arrivalsToday: "-",
      departuresToday: "-",
      roomsDirty: "-",
      roomsCleanInspected: "-",
      roomsOutOfOrder: "-",
      openMaintenanceTasks: "-",
      guestMessages: "-",
      unpaidBalances: "-",
      failedComplianceRecords: "-",
      todayRevenue: "-",
      aiDailyBriefing: "Loading briefing."
    } as DashboardSnapshot);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>HotelOS Madrid Centro</Text>
          <Text style={styles.title}>Today</Text>
        </View>
        <ShieldCheck color={colors.primary} size={28} />
      </View>

      <View style={styles.metricGrid}>
        <MetricTile label="Arrivals" value={data.arrivalsToday} tone="success" />
        <MetricTile label="Departures" value={data.departuresToday} />
        <MetricTile label="Dirty rooms" value={data.roomsDirty} tone="warning" />
        <MetricTile label="Clean inspected" value={data.roomsCleanInspected} tone="success" />
        <MetricTile label="Out of order" value={data.roomsOutOfOrder} tone="danger" />
        <MetricTile label="Open work orders" value={data.openMaintenanceTasks} tone="warning" />
        <MetricTile label="Guest messages" value={data.guestMessages} />
        <MetricTile label="Failed compliance" value={data.failedComplianceRecords} tone="danger" />
      </View>

      <View style={styles.band}>
        <Text style={styles.bandLabel}>AI daily briefing</Text>
        <Text style={styles.bandText}>{data.aiDailyBriefing}</Text>
      </View>

      <View style={styles.rowList}>
        <Text style={styles.sectionTitle}>Priority arrivals</Text>
        <View style={styles.listItem}>
          <Text style={styles.itemTitle}>RES-18392</Text>
          <Text style={styles.itemMeta}>Maria Lopez Garcia - Room 432 - Balance 0 EUR</Text>
        </View>
        <View style={styles.listItem}>
          <Text style={styles.itemTitle}>Compliance inbox</Text>
          <Text style={styles.itemMeta}>Missing phone on one guest register record</Text>
        </View>
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
    fontSize: 13,
    fontWeight: "600",
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
  band: {
    backgroundColor: "#e6f2ef",
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding: 16
  },
  bandLabel: {
    color: colors.primaryDark,
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 0
  },
  bandText: {
    marginTop: 6,
    color: colors.ink,
    fontSize: 16,
    lineHeight: 23,
    letterSpacing: 0
  },
  rowList: {
    gap: 10
  },
  sectionTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 18,
    letterSpacing: 0
  },
  listItem: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 12
  },
  itemTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0
  },
  itemMeta: {
    color: colors.muted,
    marginTop: 4,
    letterSpacing: 0
  }
});
