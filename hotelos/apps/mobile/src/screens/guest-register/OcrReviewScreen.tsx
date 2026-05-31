import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ConfidenceMeter, StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function OcrReviewScreen() {
  const fields = [
    ["First name", "Maria", 0.96],
    ["Document number", "12345678Z", 0.93],
    ["Support number", "ABC123456", 0.78],
    ["Nationality", "ES", 0.91]
  ] as const;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>OCR review</Text>
      <Text style={styles.title}>Temporary ID scan</Text>
      <View style={styles.notice}>
        <StatusChip label="Image discarded" tone="success" />
        <Text style={styles.body}>La imagen del documento no se almacena. Solo se guardan los datos necesarios para el registro legal.</Text>
      </View>
      {fields.map(([label, value, confidence]) => (
        <View key={label} style={styles.card}>
          <Text style={styles.cardTitle}>{label}</Text>
          <Text style={styles.value}>{value}</Text>
          <ConfidenceMeter value={confidence} label={`OCR confidence ${Math.round(confidence * 100)}%`} />
        </View>
      ))}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Manual verification</Text>
        <Text style={styles.body}>Reception visually checks the document. No raw ID image is sent to general AI models.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  kicker: { color: colors.muted, fontWeight: "800", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 32, fontWeight: "800", letterSpacing: 0 },
  notice: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: "800", letterSpacing: 0 },
  value: { color: colors.ink, fontSize: 18, fontWeight: "700", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 20, letterSpacing: 0 }
});
