import { ScrollView, StyleSheet, Text, View } from "react-native";
import { IntegrationCard, SmartTipCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const providers = [
  ["Booking.com Mock", "OTAs", "connected"],
  ["Expedia Mock", "OTAs", "error"],
  ["Demo PSP", "Payments", "connected"],
  ["SES.HOSPEDAJES", "Government Compliance", "needs setup"],
  ["Smart Locks", "Locks", "available"],
  ["BI Warehouse", "BI", "available"],
  ["AI OCR Provider", "AI", "needs setup"]
];

export function IntegrationMarketplaceHome() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Integration Marketplace</Text>
        <Text style={styles.title}>Connect the hotel operating system</Text>
        <Text style={styles.subtitle}>Channel Managers, OTAs, payments, locks, guest journey, CRM, revenue, housekeeping, accounting, POS, BI, government compliance and AI stay visible.</Text>
      </View>
      <View style={styles.categories}>
        {["Channel Managers", "OTAs", "Payments", "Locks", "Guest Journey", "CRM", "Revenue", "Housekeeping", "Accounting", "POS", "BI", "Government Compliance", "AI"].map((category) => (
          <StatusChip key={category} label={category} tone="info" compact />
        ))}
      </View>
      <View style={styles.grid}>
        {providers.map(([name, category, status]) => (
          <IntegrationCard key={name} name={name} category={category} status={status} />
        ))}
      </View>
      <SmartTipCard
        title="Marketplace next step"
        insight="SES.HOSPEDAJES and AI OCR are required before production go-live approval."
        suggestedAction="Open Setup Center and complete government compliance plus AI setup."
        risk="medium"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 24, padding: 18, gap: 8 },
  kicker: { color: "#c7d2fe", fontWeight: "900", letterSpacing: 0 },
  title: { color: "#ffffff", fontSize: 30, fontWeight: "900", letterSpacing: 0 },
  subtitle: { color: "#e0e7ff", lineHeight: 22, letterSpacing: 0 },
  categories: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  grid: { gap: 10 }
});
