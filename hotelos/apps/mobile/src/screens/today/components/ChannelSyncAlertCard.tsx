import { Pressable, StyleSheet, Text, View } from "react-native";
import { HotelCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../../theme/colors";

type ChannelStatus = "ok" | "warning" | "error";

type ChannelRow = {
  channel: string;
  lastSync: string;
  status: ChannelStatus;
  detail: string;
};

const rows: ChannelRow[] = [
  { channel: "Booking.com (mock)", lastSync: "10:42", status: "warning", detail: "1 ARI push retried; parity alert pending review." },
  { channel: "Expedia (mock)", lastSync: "06:14", status: "error", detail: "Credential expired; rate updates blocked." },
  { channel: "Google Hotels (mock)", lastSync: "10:39", status: "ok", detail: "Rates and inventory in sync." },
  { channel: "Direct booking engine", lastSync: "10:43", status: "ok", detail: "Price parity ok against OTAs." }
];

function tone(status: ChannelStatus) {
  if (status === "ok") return "success" as const;
  if (status === "warning") return "warning" as const;
  return "error" as const;
}

export function ChannelSyncAlertCard(props: { onNavigate?: (route: string) => void }) {
  const failed = rows.filter((row) => row.status !== "ok").length;
  return (
    <HotelCard title="Channel sync alerts" subtitle="Distribution status before rate or inventory changes">
      <View style={styles.summary}>
        <StatusChip label={failed > 0 ? `${failed} channels need attention` : "All channels in sync"} tone={failed > 0 ? "warning" : "success"} />
        <Text style={styles.summaryText}>Rate automation pauses when any channel has a failed push or a credential error.</Text>
      </View>
      {rows.map((row) => (
        <View key={row.channel} style={styles.row}>
          <View style={styles.rowHead}>
            <Text style={styles.channel}>{row.channel}</Text>
            <StatusChip label={row.status === "ok" ? "ok" : row.status === "warning" ? "retry" : "failed"} tone={tone(row.status)} />
          </View>
          <Text style={styles.detail}>{row.detail}</Text>
          <Text style={styles.lastSync}>Last sync {row.lastSync}</Text>
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Channel Manager" onPress={() => props.onNavigate?.("ChannelManagerHome")} style={styles.button}>
          <Text style={styles.buttonText}>Open Channel Manager</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Sync Health" onPress={() => props.onNavigate?.("ChannelSyncHealth")} style={styles.buttonSecondary}>
          <Text style={styles.buttonSecondaryText}>Sync Health</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Parity Alerts" onPress={() => props.onNavigate?.("RateParityAlerts")} style={styles.buttonSecondary}>
          <Text style={styles.buttonSecondaryText}>Parity Alerts</Text>
        </Pressable>
      </View>
    </HotelCard>
  );
}

const styles = StyleSheet.create({
  summary: { gap: 6 },
  summaryText: { color: colors.muted, lineHeight: 20, letterSpacing: 0 },
  row: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10, gap: 4 },
  rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  channel: { color: colors.ink, fontWeight: "900", letterSpacing: 0 },
  detail: { color: colors.muted, lineHeight: 19, letterSpacing: 0 },
  lastSync: { color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 44, borderRadius: 8, backgroundColor: colors.primary, justifyContent: "center", paddingHorizontal: 12 },
  buttonText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 },
  buttonSecondary: { minHeight: 44, borderRadius: 8, borderColor: colors.primary, borderWidth: 1, justifyContent: "center", paddingHorizontal: 12 },
  buttonSecondaryText: { color: colors.primary, fontWeight: "900", letterSpacing: 0 }
});
