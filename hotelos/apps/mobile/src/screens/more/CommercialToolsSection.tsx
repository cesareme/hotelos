import { Pressable, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { getModuleRouteItems, type ModuleRouteMapItem } from "@hotelos/product";
import { colors } from "../../theme/colors";

export function CommercialToolsSection(props: { onNavigate?: (route: string) => void }) {
  const tools = getModuleRouteItems("revenue_profit_engine", "mobile");

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>Commercial Tools</Text>
        <StatusChip label="Revenue enabled" tone="success" />
      </View>
      {tools.map((tool) => (
        <ToolCard key={`${tool.label}-${tool.route}`} item={tool} onNavigate={props.onNavigate} />
      ))}
    </View>
  );
}

function ToolCard(props: { item: ModuleRouteMapItem; onNavigate?: (route: string) => void }) {
  const route = props.item.route;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.item.label}`}
      disabled={!route}
      onPress={() => route && props.onNavigate?.(route)}
      style={styles.card}
    >
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{props.item.label}</Text>
        <StatusChip
          label={props.item.status === "coming_soon" ? "In progress" : props.item.status === "needs_setup" ? "Needs setup" : "Ready"}
          tone={props.item.status === "ready" ? "success" : props.item.status === "coming_soon" ? "info" : "warning"}
        />
      </View>
      <Text style={styles.cardBody}>{props.item.description}</Text>
      <Text style={styles.permission}>Permission: {props.item.permission}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 10
  },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 0
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 8
  },
  cardHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center"
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "900",
    letterSpacing: 0,
    flex: 1
  },
  cardBody: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  permission: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0
  }
});
