import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { getManualSetupOptionsByGroup, MANUAL_SETUP_COVERAGE_SUMMARY } from "@hotelos/product";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const groupedOptions = getManualSetupOptionsByGroup();

export function ManualSetupPreviewScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Back Office / Manual Setup</Text>
        <Text style={styles.title}>Manual Setup Center</Text>
        <Text style={styles.body}>
          Every hotel-entered setup option is visible here with the input categories, permission, route and database target needed
          to configure HotelOS without AI migration.
        </Text>
        <View style={styles.chips}>
          <StatusChip label={`${MANUAL_SETUP_COVERAGE_SUMMARY.uncheckedOptions} unchecked blockers`} tone="success" />
          <StatusChip label={`${MANUAL_SETUP_COVERAGE_SUMMARY.totalOptions} setup routes`} tone="info" />
        </View>
      </View>
      {Object.entries(groupedOptions).map(([group, options]) => (
        <View key={group} style={styles.section}>
          <Text style={styles.sectionTitle}>{group}</Text>
          {options.map((option) => (
            <Pressable
              key={option.code}
              accessibilityRole="button"
              accessibilityLabel={`Open ${option.label}`}
              onPress={() => props.onNavigate?.(option.mobileRoute ?? "BackOfficePreview")}
              style={styles.card}
            >
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>{option.label}</Text>
                <StatusChip label={option.status} tone={option.status === "needs_setup" ? "warning" : "success"} />
              </View>
              <Text style={styles.body}>{option.description}</Text>
              <Text style={styles.meta}>Route: {option.adminPath}</Text>
              <Text style={styles.meta}>Permission: {option.permission}</Text>
              <Text style={styles.meta}>Target: {option.targetTables.join(", ")}</Text>
              <Text style={styles.meta}>Input methods: {option.inputMethods.map((method) => method.label).join(", ")}</Text>
              <Text style={styles.meta}>Checks: {option.completionChecks.map((check) => check.label).join(" · ")}</Text>
              <View style={styles.chips}>
                {option.inputCategories.slice(0, 4).map((category) => (
                  <StatusChip key={category} label={category} tone="info" />
                ))}
              </View>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 16 },
  header: { gap: 8 },
  kicker: { color: colors.muted, fontWeight: "900", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 30, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  section: { gap: 10 },
  sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: "900", letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0, flex: 1 },
  meta: { color: colors.ink, fontSize: 12, fontWeight: "800", letterSpacing: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 }
});
