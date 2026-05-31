import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HotelCard, MetricCard, SmartTipCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

type ChannelTool = {
  title: string;
  detail: string;
  status: "ready" | "warning" | "error" | "needs setup";
  route: string;
};

const tools: ChannelTool[] = [
  { title: "Channels", detail: "Connected channels, provider credentials and commission model.", status: "ready", route: "ChannelSyncHealth" },
  { title: "Mappings", detail: "Internal room/rate plan to OTA room and rate codes.", status: "warning", route: "ChannelSyncHealth" },
  { title: "Sync Health", detail: "ARI jobs, retry queue, failed pushes and idempotency.", status: "warning", route: "ChannelSyncHealth" },
  { title: "Reservations Import", detail: "OTA reservations, modifications and cancellations.", status: "ready", route: "ChannelSyncHealth" },
  { title: "Parity Alerts", detail: "Direct vs OTA price mismatches and undercutting.", status: "error", route: "RateParityAlerts" },
  { title: "Settings", detail: "Automation limits, pooled inventory and sync policy.", status: "needs setup", route: "RevenueSettings" }
];

export function ChannelManagerHomeScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Channel Manager</Text>
        <Text style={styles.title}>Distribution command center</Text>
        <Text style={styles.subtitle}>Connected channels, mappings, ARI sync, reservation import and parity alerts are visible in one place.</Text>
      </View>

      <View style={styles.metrics}>
        <MetricCard label="Connected" value="4" detail="Direct + mock OTAs" tone="success" />
        <MetricCard label="Last sync" value="10:42" detail="Rates ok" tone="info" />
        <MetricCard label="Failed jobs" value="1" detail="Expedia credential" tone="warning" />
        <MetricCard label="Parity alerts" value="1" detail="Critical" tone="error" />
      </View>

      <View style={styles.grid}>
        {tools.map((tool) => (
          <Pressable key={tool.title} accessibilityRole="button" accessibilityLabel={`Open ${tool.title}`} onPress={() => props.onNavigate?.(tool.route)} style={styles.card}>
            <Text style={styles.cardTitle}>{tool.title}</Text>
            <Text style={styles.cardBody}>{tool.detail}</Text>
            <StatusChip label={tool.status} tone={tool.status === "error" ? "error" : tool.status === "warning" || tool.status === "needs setup" ? "warning" : "success"} />
          </Pressable>
        ))}
      </View>

      <HotelCard title="Mapping health" subtitle="Missing mappings block channel sync">
        <Text style={styles.body}>Booking.com mock is mapped. Expedia mock has a credential error. Google Hotels mock is ready for price feed validation.</Text>
      </HotelCard>

      <SmartTipCard
        title="Fix sync before pricing changes"
        insight="One channel has failed sync. Rate automation is blocked until sync health and mappings are valid."
        suggestedAction="Open Sync Health, repair credentials, then retry failed ARI job."
        risk="high"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 24, padding: 18, gap: 8 },
  kicker: { color: "#c7d2fe", fontWeight: "900", letterSpacing: 0 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  subtitle: { color: "#e0e7ff", lineHeight: 22, letterSpacing: 0 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  grid: { gap: 10 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0 },
  cardBody: { color: colors.muted, lineHeight: 20, letterSpacing: 0 },
  body: { color: colors.ink, lineHeight: 21, letterSpacing: 0 }
});
