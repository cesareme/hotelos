import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { HotelCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../../theme/colors";
import { checkInSteps, type CheckInStepCode } from "./checkInFlowData";

export function CheckInFlowScaffold(props: {
  activeStep: CheckInStepCode;
  title: string;
  subtitle: string;
  stateLabel: string;
  children: ReactNode;
}) {
  const activeIndex = checkInSteps.findIndex((step) => step.code === props.activeStep);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.kicker}>AI Check-in</Text>
          <Text style={styles.title}>{props.title}</Text>
          <Text style={styles.subtitle}>{props.subtitle}</Text>
        </View>
        <StatusChip label={props.stateLabel} tone={props.activeStep === "success" ? "success" : "ai"} />
      </View>

      <HotelCard>
        <View style={styles.stepRail}>
          {checkInSteps.map((step, index) => {
            const isComplete = index < activeIndex;
            const isActive = index === activeIndex;
            return (
              <View key={step.code} style={[styles.step, isComplete && styles.completeStep, isActive && styles.activeStep]}>
                <Text style={[styles.stepText, (isComplete || isActive) && styles.activeStepText]}>{step.label}</Text>
              </View>
            );
          })}
        </View>
      </HotelCard>

      {props.children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12
  },
  headerText: {
    flex: 1,
    minWidth: 0
  },
  kicker: {
    color: colors.muted,
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 0
  },
  subtitle: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  stepRail: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  step: {
    minHeight: 34,
    minWidth: 74,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    backgroundColor: colors.surfaceSoft
  },
  activeStep: {
    borderColor: colors.electric,
    backgroundColor: "#eef2ff"
  },
  completeStep: {
    borderColor: colors.success,
    backgroundColor: "#dcfce7"
  },
  stepText: {
    color: colors.muted,
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 0
  },
  activeStepText: {
    color: colors.primary
  }
});
