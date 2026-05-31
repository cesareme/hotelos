import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ShieldCheck } from "lucide-react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function GuestRegisterInboxScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>Spain Guest Register</Text>
          <Text style={styles.title}>Compliance inbox</Text>
        </View>
        <ShieldCheck color={colors.primary} size={28} />
      </View>
      <View style={styles.card}>
        <StatusChip label="Due in < 4 hours" tone="warning" />
        <Text style={styles.cardTitle}>Room 432 ready for SES.HOSPEDAJES</Text>
        <Text style={styles.body}>Signed parte de entrada, verified identity, ID_IMAGE_DISCARDED logged, queued for authority submission.</Text>
      </View>
      <View style={styles.card}>
        <StatusChip label="Rejected" tone="error" />
        <Text style={styles.cardTitle}>Invalid document support number</Text>
        <Text style={styles.body}>Correct the field, keep the audit trail, then retry the authority submission.</Text>
      </View>
      <View style={styles.card}>
        <StatusChip label="Minor" tone="neutral" />
        <Text style={styles.cardTitle}>Child under 14</Text>
        <Text style={styles.body}>No signature required; accompanying adult and kinship relation are required.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  kicker: { color: colors.muted, fontWeight: "800", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: "800", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 20, letterSpacing: 0 }
});
