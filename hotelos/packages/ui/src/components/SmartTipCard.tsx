import { StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../tokens/index.js";
import { StatusChip } from "./shared.js";

const tokens = hotelOSTokens;

export function SmartTipCard(props: {
  title?: string;
  insight: string;
  suggestedAction: string;
  signals?: string[];
  risk?: "low" | "medium" | "high";
}) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.kicker}>AI Smart Tip</Text>
        <StatusChip label={props.risk ?? "low"} tone={props.risk === "high" ? "warning" : "ai"} compact />
      </View>
      <Text style={styles.title}>{props.title ?? "Suggested next action"}</Text>
      <Text style={styles.body}>{props.insight}</Text>
      {props.signals?.length ? (
        <View style={styles.signals}>
          {props.signals.map((signal) => (
            <Text key={signal} style={styles.signal}>• {signal}</Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.action}>{props.suggestedAction}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    borderRadius: tokens.radius.lg,
    backgroundColor: tokens.color.status.ai,
    padding: tokens.space.md,
    gap: tokens.space.sm,
    ...tokens.elevation.card
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.space.sm
  },
  kicker: {
    color: tokens.color.brand.violet,
    fontSize: tokens.font.size.caption,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  title: {
    color: tokens.color.text.primary,
    fontSize: tokens.font.size.title,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  body: {
    color: tokens.color.text.secondary,
    lineHeight: 21,
    letterSpacing: 0
  },
  signals: {
    gap: 4
  },
  signal: {
    color: tokens.color.text.muted,
    lineHeight: 19,
    letterSpacing: 0
  },
  action: {
    color: tokens.color.brand.deepIndigo,
    fontWeight: tokens.font.weight.black,
    lineHeight: 20,
    letterSpacing: 0
  }
});
