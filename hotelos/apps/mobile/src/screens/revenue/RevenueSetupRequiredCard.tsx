import { Pressable, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function RevenueSetupRequiredCard(props: { localDev?: boolean; onNavigate?: (route: string) => void }) {
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Revenue Management</Text>
        <StatusChip label="Needs setup" tone="warning" />
      </View>
      <Text style={styles.body}>Missing: rate plans, inventory days, channel mappings, forecast data and revenue snapshots.</Text>
      <View style={styles.list}>
        {["Rate plans configured", "Inventory generated", "Forecast snapshots available", "Channel mappings configured", "Competitor set configured", "History & Forecast data available"].map((item) => (
          <Text key={item} style={styles.item}>- {item}</Text>
        ))}
      </View>
      <View style={styles.actions}>
        <Action label="Configure Revenue" route="RevenueSettings" onNavigate={props.onNavigate} />
        {props.localDev ? <Action label="Generate demo data" route="RevenueHistoryForecast" onNavigate={props.onNavigate} /> : null}
        <Action label="Open setup checklist" route="BackOfficePreview" onNavigate={props.onNavigate} />
      </View>
    </View>
  );
}

function Action(props: { label: string; route: string; onNavigate?: (route: string) => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={() => props.onNavigate?.(props.route)} style={styles.button}>
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#fffbeb", borderColor: "#f59e0b", borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
  head: { flexDirection: "row", justifyContent: "space-between", gap: 10, alignItems: "center" },
  title: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0, flex: 1 },
  body: { color: colors.ink, lineHeight: 21, letterSpacing: 0 },
  list: { gap: 4 },
  item: { color: colors.muted, letterSpacing: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 44, borderRadius: 8, backgroundColor: colors.primary, justifyContent: "center", paddingHorizontal: 12 },
  buttonText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 }
});
