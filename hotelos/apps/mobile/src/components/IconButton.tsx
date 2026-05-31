import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

type IconButtonProps = {
  label: string;
  icon: ReactNode;
  onPress: () => void;
  variant?: "primary" | "secondary" | "plain";
};

export function IconButton({ label, icon, onPress, variant = "secondary" }: IconButtonProps) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, styles[variant], pressed && styles.pressed]}>
      <View style={styles.icon}>{icon}</View>
      <Text style={[styles.label, variant === "primary" && styles.primaryLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1
  },
  primary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  secondary: {
    backgroundColor: colors.surface,
    borderColor: colors.line
  },
  plain: {
    backgroundColor: "transparent",
    borderColor: "transparent"
  },
  pressed: {
    opacity: 0.78
  },
  icon: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center"
  },
  label: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0
  },
  primaryLabel: {
    color: "#ffffff"
  }
});

