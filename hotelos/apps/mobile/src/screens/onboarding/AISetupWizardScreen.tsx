import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const wizardSteps = [
  ["1", "Select source system", "Mews, OPERA/OHIP, Cloudbeds, Apaleo, generic PMS or manual setup."],
  ["2", "Choose import method", "Connect source PMS, upload CSV/XLSX/PDF, room list, floor plan, rate sheet, channel mapping or describe by voice."],
  ["3", "Upload or connect data", "Files are encrypted in temporary onboarding storage and source credentials are stored only as secret references."],
  ["4", "AI classifies files", "Room lists, rate sheets, future reservations, channel mappings, floor plans and revenue reports are detected."],
  ["5", "AI extracts data", "Tables, fields and source references are extracted with confidence and missing-data markers."],
  ["6", "Generate Hotel Blueprint", "AI proposes property, buildings, floors, zones, rooms, spaces, resources and setup structure."],
  ["7", "Review property map", "Rooms, floors, zones and room types stay in review until a human approves them."],
  ["8", "Review rates", "Rate plans, restrictions and rate history are mapped before any pricing data is created."],
  ["9", "Review channels", "Channel room/rate mappings are validated before ARI sync can be enabled."],
  ["10", "Review reservations", "Future reservations, guests, deposits and balances are checked before live import."],
  ["11", "Review compliance", "Spain guest register, authority routing, tax and retention setup are checked."],
  ["12", "Review revenue history", "History & Forecast reports are validated against subtotals and total rows before snapshot import."],
  ["13", "Data quality check", "Blocking issues stop go-live; warnings require operating decisions."],
  ["14", "Dry-run migration", "Preview create, update, link and skip counts, conflicts and rollback safety."],
  ["15", "Apply approved batches", "Apply only after dry-run, explicit confirmation, zero blockers and zero pending reviews."],
  ["16", "Go-live readiness", "Cutover plan, freeze window, delta import, channel switch and first night audit are coordinated."]
];

export function AISetupWizardScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <StatusChip label="AI Onboarding & Migration" tone="ai" />
        <Text style={styles.title}>AI Setup Wizard</Text>
        <Text style={styles.heroBody}>Upload what you have. HotelOS AI classifies, extracts and maps it, then asks for approval before anything goes live.</Text>
      </View>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Upload hotel data" onPress={() => props.onNavigate?.("UploadHotelData")} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Upload hotel data</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Review onboarding project" onPress={() => props.onNavigate?.("OnboardingProject")} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Open demo project</Text>
        </Pressable>
      </View>
      {wizardSteps.map(([step, title, body]) => (
        <View key={step} style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.step}>{step}</Text>
            <StatusChip label={Number(step) < 4 ? "demo ready" : "review required"} tone={Number(step) < 4 ? "success" : "warning"} />
          </View>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 18, padding: 18, gap: 10 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  heroBody: { color: "#dbeafe", lineHeight: 22, letterSpacing: 0 },
  actions: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  primaryButton: { minHeight: 44, backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 14, justifyContent: "center" },
  primaryButtonText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 },
  secondaryButton: { minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 14, justifyContent: "center", backgroundColor: colors.surface },
  secondaryButtonText: { color: colors.ink, fontWeight: "900", letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  step: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#eef2ff", color: colors.primary, textAlign: "center", paddingTop: 8, fontWeight: "900", letterSpacing: 0 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 }
});
