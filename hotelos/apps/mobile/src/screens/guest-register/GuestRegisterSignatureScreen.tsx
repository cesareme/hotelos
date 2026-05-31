import { ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function GuestRegisterSignatureScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>Parte de entrada</Text>
      <Text style={styles.title}>Signature</Text>
      <View style={styles.signatureBox}>
        <Text style={styles.signatureText}>Guest signature area</Text>
      </View>
      <View style={styles.card}>
        <StatusChip label="Older than 14" tone="warning" />
        <Text style={styles.body}>Signature is required before check-in submission.</Text>
      </View>
      <View style={styles.card}>
        <StatusChip label="Minor under 14" tone="neutral" />
        <Text style={styles.body}>No signature; accompanying adult and relationship are recorded.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  kicker: { color: colors.muted, fontWeight: "800", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 32, fontWeight: "800", letterSpacing: 0 },
  signatureBox: { minHeight: 180, borderRadius: 8, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  signatureText: { color: colors.muted, fontWeight: "700", letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  body: { color: colors.muted, lineHeight: 20, letterSpacing: 0 }
});
