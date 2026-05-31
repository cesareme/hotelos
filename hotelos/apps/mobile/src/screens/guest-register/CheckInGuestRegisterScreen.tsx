import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ConfirmationCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function CheckInGuestRegisterScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>Check-in legal flow</Text>
      <Text style={styles.title}>Guest register</Text>
      {["Identity", "Residence", "Contact", "Travel group", "Minors", "Reservation / contract", "Payment", "Signature", "Authority submission"].map((section) => (
        <View key={section} style={styles.card}>
          <StatusChip label="Required/legal" tone="warning" />
          <Text style={styles.cardTitle}>{section}</Text>
          <Text style={styles.body}>Shows OCR confidence, manual edit, validation status, authority mapping and privacy notes where sensitive.</Text>
        </View>
      ))}
      <ConfirmationCard
        title="Confirm guest register submission"
        summary="Will create the parte de entrada, keep only legal fields, discard document image, request signature if older than 14 and queue SES.HOSPEDAJES."
        riskLevel="high"
        actions={["Save required legal fields", "Log ID_IMAGE_DISCARDED", "Capture signature", "Queue authority submission"]}
        primaryActionLabel="Queue submission"
        secondaryActionLabel="Review fields"
        onConfirm={() => undefined}
        onCancel={() => undefined}
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
