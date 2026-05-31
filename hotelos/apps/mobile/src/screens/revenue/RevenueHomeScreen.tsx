import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { getModuleRouteItems, type ModuleRouteMapItem } from "@hotelos/product";
import { colors } from "../../theme/colors";
import { RevenueSetupRequiredCard } from "./RevenueSetupRequiredCard";

const extraTools: ModuleRouteMapItem[] = [
  { label: "Overview", route: "RevenueDashboard", permission: "revenue.read", description: "Revenue dashboard with occupancy, ADR, RevPAR, GOPPAR and net revenue.", status: "ready" },
  { label: "Forecast Graphs", route: "RevenueForecastGraph", permission: "revenue.forecast.read", description: "Forecast lines, confidence bands and drivers.", status: "ready" },
  { label: "Rate Parity", route: "RateParityAlerts", permission: "channel_manager.read", description: "Direct versus OTA undercutting alerts and parity checks.", status: "ready" },
  { label: "Settings", route: "RevenueSettings", permission: "revenue.configure", description: "Pricing horizon, thresholds, channel costs and automation.", status: "needs_setup" }
];

export function RevenueHomeScreen(props: { onNavigate?: (route: string) => void }) {
  const tools = [...extraTools, ...getModuleRouteItems("revenue_profit_engine", "mobile")];
  const deduped = tools.filter((tool, index, all) => all.findIndex((candidate) => candidate.label === tool.label) === index);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <StatusChip label="Revenue & Profit Engine" tone="ai" />
        <Text style={styles.title}>Revenue Management</Text>
        <Text style={styles.heroText}>Forecast demand, control distribution, review recommendations and open the exact History & Forecast report, Rate Grid, Channel Manager and Scenario Simulator without hidden routes.</Text>
      </View>
      <RevenueSetupRequiredCard localDev onNavigate={props.onNavigate} />
      <View style={styles.grid}>
        {deduped.map((tool) => (
          <Pressable key={`${tool.label}-${tool.route}`} accessibilityRole="button" accessibilityLabel={`Open ${tool.label}`} onPress={() => tool.route && props.onNavigate?.(tool.route)} style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>{tool.label}</Text>
              <StatusChip label={tool.status === "ready" ? "Ready" : tool.status === "coming_soon" ? "Coming soon" : "Needs setup"} tone={tool.status === "ready" ? "success" : tool.status === "coming_soon" ? "info" : "warning"} />
            </View>
            <Text style={styles.body}>{tool.description}</Text>
            <Text style={styles.permission}>Required permission: {tool.permission}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 18, padding: 18, gap: 10 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  heroText: { color: "#dbeafe", lineHeight: 22, letterSpacing: 0 },
  grid: { gap: 10 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", gap: 10, alignItems: "center" },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", flex: 1, letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  permission: { color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 0 }
});
