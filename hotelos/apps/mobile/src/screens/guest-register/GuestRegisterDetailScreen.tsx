import { ScrollView, StyleSheet, Text, View } from "react-native";
import { AuditTrailPanel, StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function GuestRegisterDetailScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>Guest register detail</Text>
      <Text style={styles.title}>RES-18392</Text>
      <View style={styles.card}>
        <StatusChip label="Ready to submit" tone="success" />
        <Text style={styles.cardTitle}>Maria Lopez Garcia</Text>
        <Text style={styles.body}>Identity verified visually. Signature captured. SES.HOSPEDAJES submission queued. Retention until 2029-05-18.</Text>
      </View>
      <View style={styles.card}>
        <StatusChip label="Sensitive" tone="warning" />
        <Text style={styles.body}>Document number, support number, phone, email and payment reference require guest_register.view_sensitive and audit every view.</Text>
      </View>
      <AuditTrailPanel
        events={[
          { action: "TemporaryIdOcrCompleted", actorType: "user", createdAt: "16:34" },
          { action: "ID_IMAGE_DISCARDED", actorType: "system", createdAt: "16:34" },
          { action: "GuestRegisterRecordSigned", actorType: "guest", createdAt: "16:37" }
        ]}
      />
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
