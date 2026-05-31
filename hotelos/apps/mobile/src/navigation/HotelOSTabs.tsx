import { Pressable, StyleSheet, Text, View } from "react-native";
import { Bot, CalendarRange, Grid3X3, LayoutDashboard, ListChecks } from "lucide-react-native";
import { hotelOSTokens } from "@hotelos/ui";
import { colors } from "../theme/colors";
import type { MobileRouteKey } from "./ModuleRoutes";

export type SuiteTabKey = "today" | "timeline" | "ai" | "operations" | "more";

const tabs: Array<{ key: SuiteTabKey; label: string; icon: typeof LayoutDashboard; accent?: boolean }> = [
  { key: "today", label: "Hoy", icon: LayoutDashboard },
  { key: "timeline", label: "Timeline", icon: CalendarRange },
  { key: "ai", label: "IA", icon: Bot, accent: true },
  { key: "operations", label: "Operaciones", icon: ListChecks },
  { key: "more", label: "Mas", icon: Grid3X3 }
];

export function HotelOSTabs(props: {
  current: MobileRouteKey;
  onSelect: (screen: SuiteTabKey) => void;
}) {
  return (
    <View style={styles.nav} accessibilityLabel="HotelOS primary mobile navigation">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = props.current === tab.key;
        const activeColor = tab.accent ? colors.accent : colors.primary;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${tab.label}`}
            key={tab.key}
            onPress={() => props.onSelect(tab.key)}
            style={[styles.item, active && styles.active, active && tab.accent && styles.aiActive]}
          >
            <Icon color={active ? activeColor : colors.muted} size={19} />
            <Text style={[styles.label, active && { color: activeColor }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: {
    minHeight: 78,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 8,
    shadowColor: colors.primaryDark,
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -8 },
    elevation: 6
  },
  item: {
    minWidth: 60,
    minHeight: 54,
    borderRadius: hotelOSTokens.radius.lg,
    alignItems: "center",
    justifyContent: "center",
    gap: 4
  },
  active: {
    backgroundColor: "#eef2ff"
  },
  aiActive: {
    backgroundColor: "#f3e8ff"
  },
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0
  }
});
