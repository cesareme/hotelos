import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { DashboardSnapshot } from "@hotelos/shared";
import { ComplianceAlertCard, HotelCard, MetricCard, ReservationCard, StatusChip } from "@hotelos/ui";
import { Sparkles } from "lucide-react-native";
import { getDashboardSnapshot } from "../../services/api";
import { colors } from "../../theme/colors";
import { RevenueSnapshotCard } from "./components/RevenueSnapshotCard";
import { ChannelSyncAlertCard } from "./components/ChannelSyncAlertCard";

export function TodayDashboardScreen(props: { onNavigate?: (route: string) => void }) {
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
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View>
            <Text style={styles.kicker}>HotelOS Aurora</Text>
            <Text style={styles.title}>Today</Text>
          </View>
          <View style={styles.aiOrb}>
            <Sparkles color="#ffffff" size={22} />
          </View>
        </View>
        <Text style={styles.heroText}>{data.aiDailyBriefing}</Text>
        <View style={styles.heroActions}>
          <StatusChip label="Next action" tone="ai" />
          <Text style={styles.heroActionText}>Check arrivals with room readiness and missing guest register data.</Text>
        </View>
      </View>

      <View style={styles.metricGrid}>
        <MetricCard label="Arrivals" value={data.arrivalsToday} detail="8 checked in" tone="success" />
        <MetricCard label="Departures" value={data.departuresToday} detail="3 folios pending" tone="info" />
        <MetricCard label="Ready rooms" value={data.roomsCleanInspected} detail="Clean inspected" tone="success" />
        <MetricCard label="Dirty rooms" value={data.roomsDirty} detail="Needs housekeeping" tone="warning" />
        <MetricCard label="Blocked" value={data.roomsOutOfOrder} detail="Maintenance risk" tone="error" />
        <MetricCard label="Revenue" value={`EUR ${data.todayRevenue}`} detail="Today" tone="ai" />
      </View>

      <HotelCard title="Action queue" subtitle="Sorted by guest impact, revenue, then compliance">
        <ReservationCard code="RES-18392" guestName="Maria Lopez Garcia" stay="May 14-16" status="arrival" balance="Balance EUR 0" nextAction="Room 432 is inspected. Request phone, signature, then check in." />
        <ComplianceAlertCard
          title="Guest register missing data"
          status="needs review"
          detail="Room 432 is missing phone number before SES.HOSPEDAJES queue."
          urgent
          suggestedAction="Ask guest before confirmation."
        />
      </HotelCard>

      <RevenueSnapshotCard onNavigate={props.onNavigate} />

      <ChannelSyncAlertCard onNavigate={props.onNavigate} />

      <View style={styles.twoColumn}>
        <HotelCard title="Rooms readiness" subtitle="Do not hide critical states">
          <View style={styles.stateLine}><Text style={styles.stateLabel}>Ready</Text><Text style={styles.stateValue}>{data.roomsCleanInspected}</Text></View>
          <View style={styles.stateLine}><Text style={styles.stateLabel}>Dirty</Text><Text style={styles.stateValue}>{data.roomsDirty}</Text></View>
          <View style={styles.stateLine}><Text style={styles.stateLabel}>Blocked</Text><Text style={styles.stateValue}>{data.roomsOutOfOrder}</Text></View>
        </HotelCard>
        <HotelCard title="Manager insight" subtitle="Owner-ready summary">
          <Text style={styles.bodyText}>Room 432 has repeated HVAC notes. Inspect before weekend demand increases.</Text>
          <StatusChip label="Revenue risk" tone="warning" />
        </HotelCard>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 18
  },
  hero: {
    backgroundColor: colors.primaryDark,
    borderRadius: 24,
    padding: 20,
    gap: 14
  },
  heroTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12
  },
  kicker: {
    color: "#c7d2fe",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0
  },
  title: {
    color: "#ffffff",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 0
  },
  aiOrb: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center"
  },
  heroText: {
    color: "#ffffff",
    fontSize: 17,
    lineHeight: 25,
    letterSpacing: 0
  },
  heroActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap"
  },
  heroActionText: {
    color: "#dbeafe",
    flex: 1,
    minWidth: 180,
    letterSpacing: 0
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12
  },
  twoColumn: {
    gap: 12
  },
  stateLine: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  stateLabel: {
    color: colors.muted,
    fontWeight: "800",
    letterSpacing: 0
  },
  stateValue: {
    color: colors.ink,
    fontWeight: "900",
    letterSpacing: 0
  },
  bodyText: {
    color: colors.ink,
    lineHeight: 22,
    letterSpacing: 0
  }
});
