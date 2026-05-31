import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ClipboardList, Hammer, Sparkles } from "lucide-react-native";
import { getOperationsSnapshot, type MobileHousekeepingBoardItem, type MobileWorkOrder } from "../services/api";
import { colors } from "../theme/colors";

export function OperationsScreen() {
  const [housekeeping, setHousekeeping] = useState<MobileHousekeepingBoardItem[]>([]);
  const [workOrders, setWorkOrders] = useState<MobileWorkOrder[]>([]);

  useEffect(() => {
    void getOperationsSnapshot().then((snapshot) => {
      setHousekeeping(snapshot.housekeeping);
      setWorkOrders(snapshot.workOrders);
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Housekeeping and maintenance</Text>
          <Text style={styles.title}>Ops</Text>
        </View>
        <ClipboardList color={colors.primary} size={28} />
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Sparkles color={colors.primary} size={22} />
          <Text style={styles.sectionTitle}>Housekeeping board</Text>
        </View>
        {housekeeping.map((item) => (
          <View key={item.room.id} style={styles.row}>
            <Text style={styles.rowTitle}>Room {item.room.number}</Text>
            <Text style={styles.rowMeta}>
              {item.room.housekeepingStatus} - {item.tasks.length ? `${item.tasks.length} open task(s)` : "no open tasks"}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Hammer color={colors.primary} size={22} />
          <Text style={styles.sectionTitle}>Work orders</Text>
        </View>
        {workOrders.map((item) => (
          <View key={item.id} style={styles.row}>
            <Text style={styles.rowTitle}>{item.title}</Text>
            <Text style={styles.rowMeta}>
              {item.priority} - {item.status} - {item.blocksRoom ? "room blocked" : "room sellable"}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 18
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
  section: {
    gap: 8
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
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14
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
