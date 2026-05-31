import { Pressable, StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../tokens/index.js";

const tokens = hotelOSTokens;

export type CommandPaletteAction = {
  label: string;
  detail: string;
  route?: string;
  risk?: "low" | "medium" | "high";
};

export function CommandPalette(props: { actions?: CommandPaletteAction[]; onSelect?: (action: CommandPaletteAction) => void }) {
  const actions =
    props.actions ??
    [
      { label: "Open History & Forecast", detail: "Revenue visual report for the current month", route: "RevenueHistoryForecast" },
      { label: "Open Channel Manager", detail: "Channels, mappings and sync health", route: "ChannelManagerDashboard" },
      { label: "Find reservation Garcia", detail: "Search reservations, guests and guest journey", route: "GuestJourney" },
      { label: "Check in guest", detail: "High-risk action; confirmation required", risk: "high" },
      { label: "Create maintenance task", detail: "Create operational task from context" },
      { label: "Send payment link", detail: "Financial action; role-gated confirmation", risk: "medium" },
      { label: "Open Back Office", detail: "Setup Center and module configuration", route: "BackOfficePreview" }
    ];

  return (
    <View style={styles.palette} accessibilityLabel="Command Palette">
      <Text style={styles.title}>Command Palette</Text>
      {actions.map((action) => (
        <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.label} onPress={() => props.onSelect?.(action)} style={styles.row}>
          <Text style={styles.label}>{action.label}</Text>
          <Text style={styles.detail}>{action.detail}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  palette: {
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    borderRadius: tokens.radius.xl,
    backgroundColor: tokens.color.surface.raised,
    padding: tokens.space.md,
    gap: tokens.space.sm,
    ...tokens.elevation.command
  },
  title: {
    color: tokens.color.text.primary,
    fontSize: tokens.font.size.title,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  row: {
    minHeight: 52,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface.soft,
    padding: tokens.space.sm,
    justifyContent: "center",
    gap: 3
  },
  label: {
    color: tokens.color.brand.deepIndigo,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  detail: {
    color: tokens.color.text.muted,
    lineHeight: 19,
    letterSpacing: 0
  }
});
