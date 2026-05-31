import { ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { DEFAULT_ENABLED_MODULES, DEFAULT_MOBILE_PERMISSIONS, getVisibleMobileRoutes } from "../../navigation/ModuleRoutes";
import { colors } from "../../theme/colors";

export function ModuleVisibilityDebugScreen() {
  const visibleRoutes = getVisibleMobileRoutes();
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>Dev Module Debug</Text>
      <Text style={styles.title}>Module Visibility</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Current user</Text>
        <Text style={styles.body}>admin@hotelos.local - Local Super Admin - HotelOS Demo Hotel</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Enabled modules</Text>
        <Text style={styles.body}>{DEFAULT_ENABLED_MODULES.join(", ")}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Permissions</Text>
        <Text style={styles.body}>{DEFAULT_MOBILE_PERMISSIONS.join(", ")}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Visible routes</Text>
        {visibleRoutes.map((route) => (
          <View key={route.route} style={styles.routeRow}>
            <StatusChip label={route.moduleCode} tone="info" />
            <Text style={styles.body}>{route.label} -> {route.route}</Text>
          </View>
        ))}
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Hidden routes with reason</Text>
        <Text style={styles.body}>Hidden because module revenue_profit_engine is disabled: no current hidden revenue routes in local demo.</Text>
        <Text style={styles.body}>Hidden because user lacks revenue.read: no current permission gaps for Local Super Admin.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  kicker: { color: colors.muted, fontWeight: "900", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 20, letterSpacing: 0 },
  routeRow: { gap: 6 }
});
