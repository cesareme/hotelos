import { StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../tokens/index.js";

const tokens = hotelOSTokens;

const toneColors = {
  neutral: tokens.color.text.muted,
  success: tokens.color.semantic.success,
  warning: tokens.color.semantic.warning,
  error: tokens.color.semantic.danger,
  ai: tokens.color.brand.violet,
  info: tokens.color.semantic.info
};

export function StatusDot(props: { label: string; tone?: keyof typeof toneColors }) {
  return (
    <View style={styles.wrap}>
      <View style={[styles.dot, { backgroundColor: toneColors[props.tone ?? "neutral"] }]} />
      <Text style={styles.label}>{props.label}</Text>
    </View>
  );
}

export function ResourceStatusDot(props: { resourceType: string; status: string }) {
  const tone = props.status.includes("blocked") || props.status.includes("out") ? "error" : props.status.includes("ready") ? "success" : "info";
  return <StatusDot label={`${props.resourceType}: ${props.status}`} tone={tone} />;
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 7
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: tokens.radius.pill
  },
  label: {
    color: tokens.color.text.secondary,
    fontWeight: tokens.font.weight.bold,
    letterSpacing: 0
  }
});
