import { ScrollView, StyleSheet, Text, View } from "react-native";
import { GuestJourneyStepper, ReservationDetailPanel, SmartTipCard, StatusChip, type GuestJourneyStep } from "@hotelos/ui";
import { colors } from "../../theme/colors";

const journey: GuestJourneyStep[] = [
  { label: "Booked", state: "completed" },
  { label: "Pre-arrival", state: "completed" },
  { label: "Online check-in", state: "completed" },
  { label: "Identity verified", state: "completed" },
  { label: "Payment verified", state: "completed" },
  { label: "Room assigned", state: "completed" },
  { label: "Arrival", state: "blocked", detail: "phone + signature needed" },
  { label: "In-house", state: "pending" },
  { label: "Service requests", state: "optional" },
  { label: "Checkout", state: "pending" },
  { label: "Invoice", state: "pending" },
  { label: "Review", state: "optional" },
  { label: "Post-stay", state: "optional" }
];

export function GuestJourneyScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>Guest Journey Center</Text>
        <Text style={styles.title}>Maria Lopez Garcia</Text>
        <Text style={styles.subtitle}>Every reservation shows its journey status, blocked step, automation state, guest-facing message state and next best action.</Text>
        <View style={styles.chips}>
          <StatusChip label="Arrival blocked" tone="warning" />
          <StatusChip label="Payment verified" tone="success" />
          <StatusChip label="Compliance pending" tone="warning" />
        </View>
      </View>

      <GuestJourneyStepper steps={journey} />

      <SmartTipCard
        title="Guest journey next best action"
        insight="Online check-in and payment are complete. Arrival is blocked only by missing phone number and signature."
        suggestedAction="Request missing legal phone, capture signature and complete check-in."
        risk="medium"
      />

      <ReservationDetailPanel journeySteps={journey} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 24, padding: 18, gap: 9 },
  kicker: { color: "#c7d2fe", fontWeight: "900", letterSpacing: 0 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  subtitle: { color: "#e0e7ff", lineHeight: 22, letterSpacing: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 }
});
