import { ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme/colors";

type RevenueScaffoldProps = {
  eyebrow: string;
  title: string;
  summary: string;
  metrics: Array<{ label: string; value: string; detail: string }>;
  cards: Array<{ title: string; status: string; body: string; actions?: string[] }>;
};

export function RevenueScaffold(props: RevenueScaffoldProps) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>{props.eyebrow}</Text>
        <Text style={styles.title}>{props.title}</Text>
        <Text style={styles.summary}>{props.summary}</Text>
      </View>
      <View style={styles.metricGrid}>
        {props.metrics.map((metric) => (
          <View style={styles.metric} key={metric.label}>
            <Text style={styles.metricLabel}>{metric.label}</Text>
            <Text style={styles.metricValue}>{metric.value}</Text>
            <Text style={styles.metricDetail}>{metric.detail}</Text>
          </View>
        ))}
      </View>
      <View style={styles.cards}>
        {props.cards.map((card) => (
          <View style={styles.card} key={card.title}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>{card.title}</Text>
              <Text style={styles.status}>{card.status}</Text>
            </View>
            <Text style={styles.body}>{card.body}</Text>
            {card.actions?.length ? (
              <View style={styles.actions}>
                {card.actions.map((action) => (
                  <Text style={styles.action} key={action}>{action}</Text>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 16 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 24, padding: 20, gap: 8 },
  eyebrow: { color: "#c7d2fe", fontWeight: "900", fontSize: 12, letterSpacing: 0 },
  title: { color: "#ffffff", fontWeight: "900", fontSize: 31, letterSpacing: 0 },
  summary: { color: "#dbeafe", fontSize: 16, lineHeight: 23, letterSpacing: 0 },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  metric: { minWidth: 148, flex: 1, backgroundColor: "#ffffff", borderRadius: 18, padding: 14, borderWidth: 1, borderColor: colors.line },
  metricLabel: { color: colors.muted, fontWeight: "800", fontSize: 12, letterSpacing: 0 },
  metricValue: { color: colors.primaryDark, fontWeight: "900", fontSize: 24, letterSpacing: 0 },
  metricDetail: { color: colors.muted, letterSpacing: 0 },
  cards: { gap: 12 },
  card: { backgroundColor: "#ffffff", borderRadius: 18, padding: 16, borderWidth: 1, borderColor: colors.line, gap: 10 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", gap: 12, alignItems: "center" },
  cardTitle: { color: colors.primaryDark, fontWeight: "900", fontSize: 18, flex: 1, letterSpacing: 0 },
  status: { color: colors.primary, borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.text, lineHeight: 21, letterSpacing: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  action: { color: "#ffffff", backgroundColor: colors.primary, overflow: "hidden", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7, fontWeight: "900", letterSpacing: 0 }
});
