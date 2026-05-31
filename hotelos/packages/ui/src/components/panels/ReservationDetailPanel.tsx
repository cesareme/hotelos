import { StyleSheet, Text, View } from "react-native";
import { hotelOSTokens } from "../../tokens/index.js";
import { AuditTrailPanel, StatusChip } from "../shared.js";
import { SmartTipCard } from "../SmartTipCard.js";
import { GuestJourneyStepper, type GuestJourneyStep } from "../guestJourney/GuestJourneyStepper.js";
import { ContextDetailPanel } from "./ContextDetailPanel.js";

const tokens = hotelOSTokens;

const defaultJourney: GuestJourneyStep[] = [
  { label: "Booked", state: "completed" },
  { label: "Pre-arrival", state: "completed" },
  { label: "Online check-in", state: "completed" },
  { label: "Identity verified", state: "completed" },
  { label: "Payment verified", state: "completed" },
  { label: "Room assigned", state: "completed" },
  { label: "Arrival", state: "pending", detail: "signature pending" },
  { label: "In-house", state: "pending" },
  { label: "Checkout", state: "pending" },
  { label: "Invoice", state: "pending" },
  { label: "Review", state: "optional" },
  { label: "Post-stay", state: "optional" }
];

export function ReservationDetailPanel(props: {
  guestName?: string;
  reservationCode?: string;
  roomLabel?: string;
  balance?: string;
  journeySteps?: GuestJourneyStep[];
}) {
  return (
    <ContextDetailPanel
      title={props.reservationCode ?? "RES-18392"}
      subtitle={`${props.guestName ?? "Maria Lopez Garcia"} · ${props.roomLabel ?? "Room 432"} · ${props.balance ?? "Balance EUR 0"}`}
      actions={[
        { label: "Check in" },
        { label: "Move" },
        { label: "Extend" },
        { label: "Split" },
        { label: "Send message" },
        { label: "Request payment" },
        { label: "Issue invoice" },
        { label: "Create task" },
        { label: "Create maintenance issue" },
        { label: "Open guest journey" },
        { label: "Open folio" },
        { label: "Cancel reservation", critical: true }
      ]}
    >
      <View style={styles.statusRow}>
        <StatusChip label="confirmed" tone="info" />
        <StatusChip label="guest register missing phone" tone="warning" />
        <StatusChip label="invoice pending" tone="neutral" />
      </View>
      <GuestJourneyStepper steps={props.journeySteps ?? defaultJourney} compact />
      <SmartTipCard
        title="Complete legal data and check in"
        insight="This guest requested quiet high floor previously. Balance is paid and room 432 is clean and inspected, but guest register is missing phone number."
        suggestedAction="Complete legal data, request signature, then confirm check-in."
        signals={["Payment verified", "Guest register missing phone", "Room inspected", "Prior quiet high-floor preference"]}
        risk="medium"
      />
      <View style={styles.detailGrid}>
        {[
          ["Payments", "Paid · card token present"],
          ["Compliance", "SES.HOSPEDAJES queue ready after signature"],
          ["Upsells", "Parking eligible"],
          ["Messages", "1 open parking question"],
          ["Tasks", "No blockers"],
          ["Notes", "Quiet high floor preference"]
        ].map(([label, value]) => (
          <View style={styles.detailCell} key={label}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.value}>{value}</Text>
          </View>
        ))}
      </View>
      <AuditTrailPanel events={[
        { action: "ReservationViewed", createdAt: new Date().toISOString(), actorType: "user" },
        { action: "GuestJourneyStepCompleted", createdAt: new Date().toISOString(), actorType: "system" },
        { action: "SmartTipGenerated", createdAt: new Date().toISOString(), actorType: "ai" }
      ]} />
    </ContextDetailPanel>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.xs
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm
  },
  detailCell: {
    minWidth: 150,
    flex: 1,
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface.soft,
    padding: tokens.space.sm,
    gap: 4
  },
  label: {
    color: tokens.color.text.muted,
    fontSize: tokens.font.size.caption,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  value: {
    color: tokens.color.text.primary,
    fontWeight: tokens.font.weight.bold,
    lineHeight: 20,
    letterSpacing: 0
  }
});
