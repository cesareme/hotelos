import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SmartTipCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const setupSections = [
  ["Property", "ready", "Legal profile, timezone, address and operational defaults."],
  ["Inventory", "warning", "Rooms are mapped; non-room resources need review."],
  ["Rates", "warning", "Rate plans, rate days and History & Forecast snapshots."],
  ["Payments", "ready", "Demo PSP connected; production PSP pending."],
  ["Compliance", "blocked", "SES.HOSPEDAJES credentials missing."],
  ["Integrations", "warning", "Expedia credential expired."],
  ["AI", "warning", "OCR provider and guest disclosure need setup."],
  ["Go Live", "blocked", "2 blocking checks remain."]
];

export function SetupCenterPreviewScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Setup Center</Text>
        <Text style={styles.title}>Guided hotel setup</Text>
        <Text style={styles.subtitle}>Back Office becomes a setup center with progress, missing items, health checks and test actions.</Text>
      </View>
      <View style={styles.grid}>
        {setupSections.map(([title, status, detail]) => (
          <Pressable key={title} accessibilityRole="button" accessibilityLabel={`Open ${title} setup`} onPress={() => props.onNavigate?.(title === "Rates" ? "RevenueHome" : "BackOfficePreview")} style={styles.card}>
            <Text style={styles.cardTitle}>{title}</Text>
            <Text style={styles.cardBody}>{detail}</Text>
            <StatusChip label={status} tone={status === "blocked" ? "error" : status === "ready" ? "success" : "warning"} />
          </Pressable>
        ))}
      </View>
      <SmartTipCard
        title="Recommended setup step"
        insight="Revenue is visible but needs setup if snapshots, channel mappings or competitor set are missing."
        suggestedAction="Open Revenue, configure data quality, then generate demo data in local."
        risk="medium"
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
  grid: { gap: 10 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0 },
  cardBody: { color: colors.muted, lineHeight: 20, letterSpacing: 0 }
});
