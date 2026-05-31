import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const inputGroups = [
  ["Property profile", "Legal name, tax ID, address, timezone, currency, language, tax region and business date rules."],
  ["Buildings / floors / zones", "Building code, floor number, zone type, housekeeping section and maintenance area."],
  ["Rooms", "Room number, room type, building, floor, zone, beds, features, view, accessibility, sellable and status."],
  ["Room types", "Category, occupancy, default bed setup, default features, cleaning category and display order."],
  ["Spaces & resources", "Parking, meeting rooms, coworking, spa, restaurant, event spaces, equipment and bookable mode."],
  ["Departments", "Manager, users, operational ownership and active state."],
  ["Operations", "Housekeeping task types, cleaning schemas, maintenance issue types, priorities and SLA rules."],
  ["Revenue / finance / compliance", "Market segments, source codes, channel categories, tax codes, invoice sequences, authority types and retention."]
];

export function PropertySetupPreviewScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Back Office / Property Setup</Text>
        <Text style={styles.title}>Map the property correctly</Text>
        <Text style={styles.subtitle}>Capture every setup input category needed for property mapper, inventory resources, operations, revenue and compliance.</Text>
      </View>

      {inputGroups.map(([title, detail]) => (
        <View style={styles.card} key={title}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{title}</Text>
            <StatusChip label="input category" tone="success" />
          </View>
          <Text style={styles.body}>{detail}</Text>
        </View>
      ))}

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Go-live mapping checks</Text>
          <StatusChip label="validation" tone="warning" />
        </View>
        <Text style={styles.body}>Sellable rooms require room type, building, floor, zone, housekeeping section and maintenance area. Spaces require resource type, capacity, bookable mode, tax code and default rate.</Text>
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel="Open Category Manager" onPress={() => props.onNavigate?.("CategoryManagerPreview")} style={styles.button}>
        <Text style={styles.buttonText}>Open Category Manager</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 24, padding: 18, gap: 8 },
  kicker: { color: "#c7d2fe", fontWeight: "900", letterSpacing: 0 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  subtitle: { color: "#e0e7ff", lineHeight: 22, letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0, flex: 1 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  button: { minHeight: 44, borderRadius: 8, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  buttonText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 }
});
