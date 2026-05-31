import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { KeyRound, ShieldCheck } from "lucide-react-native";
import { getAppShellSnapshot, type MobileSecuritySettings } from "../services/api";
import { colors } from "../theme/colors";

export function SettingsScreen() {
  const [security, setSecurity] = useState<MobileSecuritySettings | null>(null);

  useEffect(() => {
    void getAppShellSnapshot().then((snapshot) => setSecurity(snapshot.security));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Settings</Text>
          <Text style={styles.title}>Security</Text>
        </View>
        <ShieldCheck color={colors.primary} size={28} />
      </View>

      <View style={styles.panel}>
        <KeyRound color={colors.primary} size={24} />
        <View style={styles.panelText}>
          <Text style={styles.panelTitle}>MFA and devices</Text>
          <Text style={styles.panelMeta}>MFA {security?.mfaEnabled ? "enabled" : "disabled"}</Text>
          <Text style={styles.panelMeta}>{security?.activeSessions ?? 0} active session(s)</Text>
          <Text style={styles.panelMeta}>{security?.registeredDevices ?? 0} registered device(s)</Text>
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.panelText}>
          <Text style={styles.panelTitle}>Sensitive roles</Text>
          <Text style={styles.panelMeta}>{security?.sensitiveRolesRequireMfa.join(", ") ?? "Loading"}</Text>
        </View>
      </View>
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
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14
  },
  panelText: {
    flex: 1,
    gap: 5
  },
  panelTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0
  },
  panelMeta: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  }
});
