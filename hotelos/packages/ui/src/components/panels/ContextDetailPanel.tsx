import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../../tokens/index.js";

const tokens = hotelOSTokens;

export function ContextDetailPanel(props: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: Array<{ label: string; onPress?: () => void; critical?: boolean }>;
}) {
  return (
    <View style={styles.panel} accessibilityLabel={`${props.title} detail panel`}>
      <View style={styles.header}>
        <View style={styles.titleStack}>
          <Text style={styles.title}>{props.title}</Text>
          {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
        </View>
      </View>
      {props.children}
      {props.actions?.length ? (
        <View style={styles.actions}>
          {props.actions.map((action) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={action.label}
              key={action.label}
              onPress={action.onPress}
              style={[styles.button, action.critical && styles.criticalButton]}
            >
              <Text style={[styles.buttonText, action.critical && styles.criticalButtonText]}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    borderRadius: tokens.radius.xl,
    backgroundColor: tokens.color.surface.raised,
    padding: tokens.space.lg,
    gap: tokens.space.md,
    ...tokens.elevation.card
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.space.sm
  },
  titleStack: {
    flex: 1,
    minWidth: 0,
    gap: 4
  },
  title: {
    color: tokens.color.text.primary,
    fontSize: tokens.font.size.title,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  subtitle: {
    color: tokens.color.text.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.xs
  },
  button: {
    minHeight: 44,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    backgroundColor: tokens.color.surface.soft,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: tokens.space.md
  },
  criticalButton: {
    backgroundColor: tokens.color.semantic.danger,
    borderColor: tokens.color.semantic.danger
  },
  buttonText: {
    color: tokens.color.brand.deepIndigo,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  criticalButtonText: {
    color: tokens.color.text.inverse
  }
});
