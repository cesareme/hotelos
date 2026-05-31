import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Bell } from "lucide-react-native";
import { getAppShellSnapshot, type MobileNotification } from "../services/api";
import { colors } from "../theme/colors";

export function NotificationsScreen() {
  const [notifications, setNotifications] = useState<MobileNotification[]>([]);

  useEffect(() => {
    void getAppShellSnapshot().then((snapshot) => setNotifications(snapshot.notifications));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Notifications</Text>
          <Text style={styles.title}>Alerts</Text>
        </View>
        <Bell color={colors.primary} size={28} />
      </View>

      {notifications.map((notification) => (
        <View key={notification.id} style={styles.row}>
          <Text style={styles.status}>{notification.type}</Text>
          <Text style={styles.rowTitle}>{notification.title}</Text>
          <Text style={styles.rowMeta}>{notification.body}</Text>
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14,
    gap: 4
  },
  status: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0
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

