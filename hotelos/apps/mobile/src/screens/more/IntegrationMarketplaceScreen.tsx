import { ScrollView, StyleSheet, Text } from "react-native";
import { INTEGRATION_CATEGORIES, INTEGRATION_PROVIDERS } from "@hotelos/integrations";
import { IntegrationCard } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function IntegrationMarketplaceScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Integration Marketplace</Text>
      {INTEGRATION_PROVIDERS.map((provider) => {
        const category = INTEGRATION_CATEGORIES.find((candidate) => candidate.code === provider.categoryCode);
        return (
          <IntegrationCard
            key={provider.code}
            name={provider.name}
            category={category?.name ?? provider.categoryCode}
            status={provider.code === "mock_payments" ? "connected" : "available"}
            capabilities={provider.capabilities}
          />
        );
      })}
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
