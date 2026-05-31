import { ScrollView, StyleSheet, Text } from "react-native";
import { HOTEL_MODULES } from "@hotelos/product";
import { ModuleCard } from "@hotelos/ui";
import { colors } from "../../theme/colors";
import { DEFAULT_ENABLED_MODULES } from "../../navigation/ModuleRoutes";

export function ModuleMarketplaceScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Module Marketplace</Text>
      {HOTEL_MODULES.map((module) => (
        <ModuleCard
          key={module.code}
          name={module.name}
          category={module.category}
          enabled={module.isCore || DEFAULT_ENABLED_MODULES.includes(module.code)}
          dependencies={module.dependencies}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 12
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 0
  }
});
