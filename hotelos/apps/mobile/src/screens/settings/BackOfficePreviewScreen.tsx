import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const previewActions = [
  { label: "Manual Setup Center", route: "ManualSetupPreview", detail: "All hotel-entered setup routes with input categories, permissions, endpoints and database targets." },
  { label: "Manual Setup / Property Setup", route: "PropertySetupPreview", detail: "Enter hotel data manually: legal profile, mapper input categories, rooms, spaces, departments and resources." },
  { label: "Category Manager", route: "CategoryManagerPreview", detail: "Categories, custom fields, setup templates, import/export and AI category suggestions." },
  { label: "Modules", route: "ModuleMarketplace", detail: "Marketplace, active modules, configuration and health." },
  { label: "Integrations", route: "IntegrationMarketplace", detail: "Connected channels, payments, messaging and compliance connectors." },
  { label: "Revenue Settings", route: "RevenueHome", detail: "Rate plans, automation, data quality and commercial setup." },
  { label: "AI Setup Wizard", route: "AISetupWizard", detail: "Migration project, uploads, AI mappings, dry-run and go-live readiness." },
  { label: "Compliance Settings", route: "compliance", detail: "Spain Guest Register, SES.HOSPEDAJES and retention." },
  { label: "AI Settings", route: "ai", detail: "AI tools, confirmations, audit and governance." }
];

export function BackOfficePreviewScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Back Office / Configuración</Text>
        <Text style={styles.title}>Setup center</Text>
        <Text style={styles.body}>Admin-web remains the primary Back Office, but this mobile fallback keeps configuration entry points visible in local/demo mode.</Text>
      </View>
      {previewActions.map((action) => (
        <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={`Open ${action.label}`} onPress={() => props.onNavigate?.(action.route)} style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{action.label}</Text>
            <StatusChip label="visible" tone="success" />
          </View>
          <Text style={styles.body}>{action.detail}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  header: { gap: 8 },
  kicker: { color: colors.muted, fontWeight: "900", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0, flex: 1 }
});
