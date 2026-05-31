import { StyleSheet, Text, View } from "react-native";
import { Sparkles } from "lucide-react-native";
import { colors } from "../../theme/colors";

export function AiDailyBriefingCard(props: { briefing: string }) {
  return (
    <View style={styles.card}>
      <Sparkles color={colors.primary} size={22} />
      <View style={styles.copy}>
        <Text style={styles.title}>AI daily briefing</Text>
        <Text style={styles.body}>{props.briefing}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: "#eef2ff",
    padding: 14
  },
  copy: {
    flex: 1,
    gap: 4
  },
  title: {
    color: colors.ink,
    fontWeight: "900",
    letterSpacing: 0
  },
  body: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  }
});
