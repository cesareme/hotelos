import { ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function SesSubmissionQueueScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>SES.HOSPEDAJES</Text>
      <Text style={styles.title}>Submission queue</Text>
      {[
        { title: "Immediate queue", body: "Runs every 15 minutes or hourly for signed records approaching deadline.", tone: "success" as const },
        { title: "Daily batch", body: "Default 06:00 property timezone; manual download and receipt reference are audited.", tone: "warning" as const },
        { title: "Manual upload needed", body: "Generated file must be uploaded to the official platform and marked with receipt.", tone: "error" as const }
      ].map(({ title, body, tone }) => (
        <View key={title} style={styles.card}>
          <StatusChip label={tone} tone={tone} />
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
      ))}
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
