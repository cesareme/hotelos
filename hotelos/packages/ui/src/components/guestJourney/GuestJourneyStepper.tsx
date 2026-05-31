import { StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../../tokens/index.js";

const tokens = hotelOSTokens;

export type GuestJourneyStepState = "pending" | "completed" | "blocked" | "failed" | "optional";

export type GuestJourneyStep = {
  label: string;
  state: GuestJourneyStepState;
  detail?: string;
};

function stateColor(state: GuestJourneyStepState) {
  if (state === "completed") return tokens.color.semantic.success;
  if (state === "blocked" || state === "failed") return tokens.color.semantic.danger;
  if (state === "optional") return tokens.color.text.muted;
  return tokens.color.semantic.warning;
}

export function GuestJourneyStepper(props: { steps: GuestJourneyStep[]; compact?: boolean }) {
  return (
    <View style={[styles.wrap, props.compact && styles.compact]} accessibilityLabel="Guest Journey steps">
      {props.steps.map((step) => (
        <View key={step.label} style={styles.step}>
          <View style={[styles.dot, { backgroundColor: stateColor(step.state) }]} />
          <View style={styles.textWrap}>
            <Text style={styles.label}>{step.label}</Text>
            <Text style={styles.state}>{step.state}{step.detail ? ` · ${step.detail}` : ""}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    borderRadius: tokens.radius.lg,
    backgroundColor: tokens.color.surface.raised,
    padding: tokens.space.md,
    gap: tokens.space.sm
  },
  compact: {
    padding: tokens.space.sm
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
    minHeight: 42
  },
  dot: {
    width: 11,
    height: 11,
    borderRadius: tokens.radius.pill
  },
  textWrap: {
    flex: 1,
    minWidth: 0
  },
  label: {
    color: tokens.color.text.primary,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  state: {
    color: tokens.color.text.muted,
    fontSize: tokens.font.size.caption,
    lineHeight: 18,
    letterSpacing: 0
  }
});
