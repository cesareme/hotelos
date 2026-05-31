import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const groups = [
  "Property",
  "Rooms",
  "Spaces & Resources",
  "Operations",
  "Maintenance",
  "Housekeeping",
  "Revenue",
  "Distribution",
  "Guest Experience",
  "Finance",
  "Compliance",
  "POS",
  "Assets",
  "Safety",
  "AI"
];

const categories = [
  ["Room features", "Balcony, Sea view, Connecting room, Pet friendly", "property_editable"],
  ["Bed types", "King bed, Twin beds, Queen bed", "property_extendable"],
  ["Revenue segments", "Direct, OTA, Corporate, Group, Walk-in", "property_extendable"],
  ["Document types", "DNI, Passport, TIE", "system_controlled"],
  ["Reservation status", "Fixed internal operational states", "read_only"]
];

export function CategoryManagerPreviewScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Configuration Center</Text>
        <Text style={styles.title}>Category Manager</Text>
        <Text style={styles.body}>
          Mobile preview for property taxonomy. Full editing lives in Back Office, while local/demo mode keeps categories, custom fields, templates and AI previews visible.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Category groups</Text>
          <StatusChip label="15 groups" tone="ai" />
        </View>
        <View style={styles.chipWrap}>
          {groups.map((group) => (
            <StatusChip key={group} label={group} tone="info" />
          ))}
        </View>
      </View>

      {categories.map(([label, detail, mode]) => (
        <View style={styles.card} key={label}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{label}</Text>
            <StatusChip label={mode} tone={mode === "system_controlled" ? "warning" : "success"} />
          </View>
          <Text style={styles.body}>{detail}</Text>
          <Text style={styles.meta}>Add option · Edit option · Deactivate · Reactivate · Reorder · Linked records · Usage count</Text>
        </View>
      ))}

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>AI category assistant</Text>
          <StatusChip label="preview required" tone="warning" />
        </View>
        <Text style={styles.body}>
          Ask AI to suggest room features, maintenance categories, housekeeping task types, revenue segments, space types, asset categories or POS categories.
        </Text>
        <Text style={styles.meta}>AI can suggest categories. AI cannot apply without confirmation.</Text>
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel="Open Back Office preview" onPress={() => props.onNavigate?.("BackOfficePreview")} style={styles.button}>
        <Text style={styles.buttonText}>Back Office Preview</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  header: { gap: 8 },
  kicker: { color: colors.muted, fontWeight: "900", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0, flex: 1 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  meta: { color: colors.primary, fontWeight: "800", lineHeight: 20, letterSpacing: 0 },
  button: { minHeight: 44, borderRadius: 8, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  buttonText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 }
});
