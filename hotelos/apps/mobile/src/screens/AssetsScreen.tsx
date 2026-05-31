import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Building2, ChartNoAxesColumnIncreasing, Hammer } from "lucide-react-native";
import {
  getAssetsSnapshot,
  type MobileAsset,
  type MobileCapexProject,
  type MobileRoomProfitability
} from "../services/api";
import { colors } from "../theme/colors";

export function AssetsScreen() {
  const [assets, setAssets] = useState<MobileAsset[]>([]);
  const [capex, setCapex] = useState<MobileCapexProject[]>([]);
  const [profitability, setProfitability] = useState<MobileRoomProfitability[]>([]);

  useEffect(() => {
    void getAssetsSnapshot().then((snapshot) => {
      setAssets(snapshot.assets);
      setCapex(snapshot.capex);
      setProfitability(snapshot.profitability);
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Real estate and assets</Text>
          <Text style={styles.title}>Asset Register</Text>
        </View>
        <Building2 color={colors.primary} size={28} />
      </View>

      <View style={styles.sectionHeader}>
        <Hammer color={colors.primary} size={22} />
        <Text style={styles.sectionTitle}>Room assets</Text>
      </View>
      {assets.map((asset) => (
        <View key={asset.id} style={styles.row}>
          <Text style={styles.rowTitle}>{asset.name}</Text>
          <Text style={styles.rowMeta}>
            {asset.assetType} - {asset.status} - warranty {asset.warrantyUntil ?? "not set"}
          </Text>
        </View>
      ))}

      <View style={styles.sectionHeader}>
        <ChartNoAxesColumnIncreasing color={colors.primary} size={22} />
        <Text style={styles.sectionTitle}>Room profitability</Text>
      </View>
      {profitability.map((room) => (
        <View key={room.roomId} style={styles.row}>
          <Text style={styles.rowTitle}>Room {room.roomNumber}</Text>
          <Text style={styles.rowMeta}>
            Revenue {room.revenue} EUR - maintenance {room.maintenanceCost} - capex planned {room.capexPlanned}
          </Text>
        </View>
      ))}

      <Text style={styles.sectionTitle}>Capex projects</Text>
      {capex.map((project) => (
        <View key={project.id} style={styles.row}>
          <Text style={styles.rowTitle}>{project.name}</Text>
          <Text style={styles.rowMeta}>
            {project.status} - budget {project.budget} EUR
          </Text>
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
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 0
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  sectionTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 18,
    letterSpacing: 0
  },
  row: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 12,
    paddingHorizontal: 2
  },
  rowTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0
  },
  rowMeta: {
    color: colors.muted,
    marginTop: 4,
    lineHeight: 20,
    letterSpacing: 0
  }
});

