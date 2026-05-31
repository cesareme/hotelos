import { ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function AuthorityBatchDetailScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>Authority batch</Text>
      <Text style={styles.title}>Daily batch</Text>
      <View style={styles.card}>
        <StatusChip label="Generated" tone="warning" />
        <Text style={styles.cardTitle}>1 record included</Text>
        <Text style={styles.body}>File export is auditable. Mark manual upload with official receipt/reference after uploading to SES.HOSPEDAJES.</Text>
      </View>
      <View style={styles.card}>
        <StatusChip label="Schema placeholder" tone="info" />
        <Text style={styles.body}>Official XML/TXT/API schema is loaded from SES.HOSPEDAJES service-web documentation in Back Office, not guessed in code.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  kicker: { color: colors.muted, fontWeight: "800", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 32, fontWeight: "800", letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: "800", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 20, letterSpacing: 0 }
});
