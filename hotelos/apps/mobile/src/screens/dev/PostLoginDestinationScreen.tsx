import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function PostLoginDestinationScreen(props: { onNavigate: (route: string) => void; canBackOffice?: boolean; canRevenue?: boolean }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>Where do you want to go?</Text>
      <Destination label="Operate Hotel" detail="Main tabs for reception, rooms, AI and tasks." route="today" onNavigate={props.onNavigate} enabled />
      <Destination label="Back Office" detail="Admin setup and module configuration." route="BackOfficePreview" onNavigate={props.onNavigate} enabled={props.canBackOffice !== false} permission="backoffice.access" />
      <Destination label="Revenue Management" detail="Commercial command center and History & Forecast." route="RevenueHome" onNavigate={props.onNavigate} enabled={props.canRevenue !== false} permission="revenue.read" />
    </ScrollView>
  );
}

function Destination(props: { label: string; detail: string; route: string; onNavigate: (route: string) => void; enabled: boolean; permission?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${props.label}`} disabled={!props.enabled} onPress={() => props.onNavigate(props.route)} style={[styles.card, !props.enabled && styles.disabled]}>
      <Text style={styles.title}>{props.label}</Text>
      <Text style={styles.body}>{props.detail}</Text>
      {props.permission ? <StatusChip label={props.enabled ? props.permission : `Required permission: ${props.permission}`} tone={props.enabled ? "success" : "warning"} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  kicker: { color: colors.muted, fontWeight: "900", fontSize: 13, letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 16, gap: 8 },
  disabled: { opacity: 0.64 },
  title: { color: colors.ink, fontSize: 20, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 }
});
