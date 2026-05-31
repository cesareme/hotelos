import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Building2, CheckCircle2 } from "lucide-react-native";
import { getAppShellSnapshot, type MobileProperty } from "../services/api";
import { colors } from "../theme/colors";

export function PropertySelectorScreen() {
  const [properties, setProperties] = useState<MobileProperty[]>([]);

  useEffect(() => {
    void getAppShellSnapshot().then((snapshot) => setProperties(snapshot.properties));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Property selector</Text>
          <Text style={styles.title}>Hotels</Text>
        </View>
        <Building2 color={colors.primary} size={28} />
      </View>

      {properties.map((property) => (
        <View key={property.id} style={styles.row}>
          <View style={styles.rowIcon}>
            <CheckCircle2 color={property.id === "prop_123" ? colors.primary : colors.muted} size={20} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{property.name}</Text>
            <Text style={styles.rowMeta}>
              {property.taxRegion ?? "No tax region"} - SES {property.sesHospedajesEnabled ? "on" : "off"} - VERI*FACTU {property.verifactuEnabled ? "on" : "off"}
            </Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  kicker: {
    color: colors.muted,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0
  },
  row: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14
  },
  rowIcon: {
    paddingTop: 2
  },
  rowText: {
    flex: 1,
    gap: 4
  },
  rowTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0
  },
  rowMeta: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  }
});

