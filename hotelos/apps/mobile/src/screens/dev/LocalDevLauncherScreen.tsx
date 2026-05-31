import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

declare const __DEV__: boolean | undefined;

export const SHOW_DEV_LAUNCHER =
  ((globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env?.EXPO_PUBLIC_SHOW_DEV_LAUNCHER === "true") ||
  (typeof __DEV__ !== "undefined" && __DEV__);

const destinations = [
  {
    label: "Operar hotel",
    route: "today",
    detail: "Recepcion, timeline, IA y operaciones diarias."
  },
  {
    label: "Back Office / Configuración",
    route: "BackOfficePreview",
    detail: "Configurar propiedad, habitaciones, modulos, integraciones, compliance y usuarios."
  },
  {
    label: "Configuration Center",
    route: "ConfigurationCenter",
    detail: "Property profile, buildings, floors, zones, rooms, room types, spaces, resources, departments, housekeeping, maintenance, revenue, compliance and AI setup cards."
  },
  {
    label: "Manual Setup Center",
    route: "ManualSetupPreview",
    detail: "All manual hotel input routes: property, categories, revenue, channels, finance, compliance, AI and users."
  },
  {
    label: "Manual Setup / Property Setup",
    route: "PropertySetupPreview",
    detail: "Enter hotel data manually: legal profile, buildings, floors, zones, room types, rooms, spaces, resources, departments and categories."
  },
  {
    label: "Revenue Management",
    route: "RevenueHome",
    detail: "Forecast, History & Forecast, Rate Grid, Channel Manager y recomendaciones."
  },
  {
    label: "History & Forecast",
    route: "RevenueHistoryForecast",
    detail: "KPIs, History vs Forecast charts, Revenue / Occupancy / ADR / RevPAR, channel mix and the detailed report table."
  },
  {
    label: "Channel Manager",
    route: "ChannelManagerHome",
    detail: "Connected channels, channel health, last sync, failed jobs, room and rate mappings, ARI sync and parity alerts."
  },
  {
    label: "AI Setup Wizard",
    route: "AISetupWizard",
    detail: "Subir exports, mapas, reservas, revenue history y dejar que AI proponga la configuracion con review y dry-run."
  },
  {
    label: "Owner Dashboard",
    route: "owner",
    detail: "Resumen ejecutivo, revenue, cash, mantenimiento y riesgos."
  }
];

export function LocalDevLauncherScreen(props: { onNavigate: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <StatusChip label="Local Demo" tone="ai" />
        <Text style={styles.title}>HotelOS Local Demo</Text>
        <Text style={styles.body}>Choose where to go. Critical setup and revenue tools stay visible in local/dev mode.</Text>
      </View>
      {destinations.map((destination) => (
        <Pressable key={destination.label} accessibilityRole="button" accessibilityLabel={`Open ${destination.label}`} onPress={() => props.onNavigate(destination.route)} style={styles.card}>
          <Text style={styles.cardTitle}>{destination.label}</Text>
          <Text style={styles.body}>{destination.detail}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 18, padding: 18, gap: 10 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 16, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 20, fontWeight: "900", letterSpacing: 0 }
});
