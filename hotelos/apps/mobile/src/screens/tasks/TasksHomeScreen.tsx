import { ScrollView, StyleSheet, Text } from "react-native";
import { ComplianceAlertCard, TaskCard } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function TasksHomeScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Operaciones</Text>
      <TaskCard title="Housekeeping board" status="open" priority="normal" detail="9 dirty rooms, 4 arrival rooms need inspection." />
      <TaskCard title="Maintenance board" status="open" priority="urgent" detail="Room 108 blocks sellable inventory." />
      <TaskCard title="Guest requests" status="open" priority="normal" detail="3 active service requests." />
      <TaskCard title="Safety incidents" status="open" priority="urgent" detail="1 incident requires manager review." />
      <ComplianceAlertCard title="Compliance inbox" status="needs_review" detail="Guest in room 432 missing phone number." urgent />
      <TaskCard title="Accounting approvals" status="pending" priority="normal" detail="Supplier bill draft awaiting review." />
      <TaskCard title="Lost & Found" status="open" priority="normal" detail="2 items awaiting guest contact." />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 0
  }
});
