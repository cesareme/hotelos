import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

type MetricTileProps = {
  label: string;
  value: string | number;
  tone?: "neutral" | "warning" | "danger" | "success";
};

export function MetricTile({ label, value, tone = "neutral" }: MetricTileProps) {
  return (
    <View style={[styles.tile, styles[tone]]}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: "48%",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: 14,
    minHeight: 88
  },
  neutral: {},
  warning: { borderColor: "#d6a43a" },
  danger: { borderColor: "#dc7b7b" },
  success: { borderColor: "#75b88b" },
  value: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.ink,
    letterSpacing: 0
  },
  label: {
    marginTop: 6,
    fontSize: 13,
    color: colors.muted,
    letterSpacing: 0
  }
});

