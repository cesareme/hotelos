import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { OfflineAction, OfflineSyncResponse } from "@hotelos/shared";
import { RefreshCcw, WifiOff } from "lucide-react-native";
import { IconButton } from "../components/IconButton";
import { listOfflineActions, syncOfflineQueue } from "../services/offlineQueue";
import { colors } from "../theme/colors";

export function OfflineSyncScreen() {
  const [actions, setActions] = useState<OfflineAction[]>([]);
  const [lastSync, setLastSync] = useState<OfflineSyncResponse | null>(null);

  useEffect(() => {
    setActions(listOfflineActions());
  }, []);

  async function sync() {
    const response = await syncOfflineQueue();
    setLastSync(response);
    setActions(listOfflineActions());
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Offline queue</Text>
          <Text style={styles.title}>Sync</Text>
        </View>
        <WifiOff color={colors.primary} size={28} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Sync policy</Text>
        <Text style={styles.panelMeta}>Housekeeping updates and maintenance drafts can sync later.</Text>
        <Text style={styles.panelMeta}>Invoice issue and final check-in stay online-only.</Text>
        <IconButton label="Sync now" icon={<RefreshCcw color="#ffffff" size={20} />} onPress={sync} variant="primary" />
      </View>

      {lastSync ? (
        <View style={styles.summary}>
          <Text style={styles.panelTitle}>Last sync</Text>
          <Text style={styles.panelMeta}>
            {lastSync.accepted} accepted, {lastSync.rejected} rejected, {lastSync.conflicts} conflict(s)
          </Text>
        </View>
      ) : null}

      {actions.map((action) => (
        <View key={action.id} style={styles.row}>
          <Text style={styles.rowTitle}>{action.type}</Text>
          <Text style={styles.rowMeta}>
            {action.status} - {action.createdAt}
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
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0
  },
  panel: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14,
    gap: 8
  },
  summary: {
    backgroundColor: "#eef7f4",
    borderWidth: 1,
    borderColor: "#b7d8d1",
    borderRadius: 8,
    padding: 14,
    gap: 4
  },
  panelTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 17,
    letterSpacing: 0
  },
  panelMeta: {
    color: colors.muted,
    lineHeight: 20,
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
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0
  },
  rowMeta: {
    color: colors.muted,
    marginTop: 4,
    letterSpacing: 0
  }
});

