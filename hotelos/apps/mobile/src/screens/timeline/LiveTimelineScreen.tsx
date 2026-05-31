import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  HotelCard,
  ReservationDetailPanel,
  ResourceStatusDot,
  SmartTipCard,
  StatusChip
} from "@hotelos/ui";
import { colors } from "../../theme/colors";

type ReservationStatus = "confirmed" | "checked_in" | "checked_out" | "cancelled";
type ReservationKind =
  | "reservation"
  | "group_block"
  | "out_of_order"
  | "out_of_service"
  | "house_use"
  | "day_use"
  | "maintenance_block"
  | "event"
  | "parking_booking"
  | "meeting_room_booking";

type Resource = {
  id: string;
  type: string;
  label: string;
  status: string;
  capacity?: string;
};

type ReservationBlock = {
  id: string;
  resourceId: string;
  guestName: string;
  status: ReservationStatus;
  kind: ReservationKind;
  detail: string;
  balance: string;
  startOffsetDays: number;
  spanDays: number;
};

const DAY_COUNT = 5;
const CELL_WIDTH = 84;

const DAYS = ["Sun 17", "Mon 18", "Tue 19", "Wed 20", "Thu 21"];

const RESOURCES: Resource[] = [
  { id: "room-401", type: "room", label: "Room 401", status: "occupied", capacity: "2 pax" },
  { id: "room-402", type: "room", label: "Room 402", status: "ready", capacity: "2 pax" },
  { id: "room-405", type: "room", label: "Room 405", status: "out_of_order", capacity: "2 pax" },
  { id: "parking-12", type: "parking_space", label: "Parking P-12", status: "bookable" },
  { id: "meeting-a", type: "meeting_room", label: "Meeting Room A", status: "ready" },
  { id: "spa-2", type: "spa_room", label: "Spa Room 2", status: "out_of_service" },
  { id: "rooftop", type: "event_space", label: "Rooftop", status: "bookable" }
];

const RESERVATIONS: ReservationBlock[] = [
  {
    id: "RES-18392",
    resourceId: "room-401",
    guestName: "Maria Lopez",
    status: "checked_in",
    kind: "reservation",
    detail: "In-house · Quiet floor",
    balance: "EUR 0",
    startOffsetDays: 0,
    spanDays: 3
  },
  {
    id: "RES-18421",
    resourceId: "room-401",
    guestName: "James Doyle",
    status: "confirmed",
    kind: "reservation",
    detail: "Pre-arrival",
    balance: "Pre-paid",
    startOffsetDays: 4,
    spanDays: 1
  },
  {
    id: "RES-18430",
    resourceId: "room-402",
    guestName: "Group: Globex",
    status: "confirmed",
    kind: "group_block",
    detail: "Group hold",
    balance: "Group dep.",
    startOffsetDays: 1,
    spanDays: 4
  },
  {
    id: "BLOCK-OOO-405",
    resourceId: "room-405",
    guestName: "Plumbing repair",
    status: "confirmed",
    kind: "out_of_order",
    detail: "OOO",
    balance: "",
    startOffsetDays: 0,
    spanDays: 4
  },
  {
    id: "PARK-501",
    resourceId: "parking-12",
    guestName: "Silva",
    status: "confirmed",
    kind: "parking_booking",
    detail: "18:00 - 10:00",
    balance: "Add-on",
    startOffsetDays: 0,
    spanDays: 2
  },
  {
    id: "MEET-301",
    resourceId: "meeting-a",
    guestName: "Design Co",
    status: "confirmed",
    kind: "meeting_room_booking",
    detail: "09:00 - 13:00",
    balance: "Pre-paid",
    startOffsetDays: 2,
    spanDays: 1
  },
  {
    id: "MAINT-SPA",
    resourceId: "spa-2",
    guestName: "HVAC repair",
    status: "confirmed",
    kind: "maintenance_block",
    detail: "Maintenance",
    balance: "",
    startOffsetDays: 0,
    spanDays: 3
  },
  {
    id: "EV-101",
    resourceId: "rooftop",
    guestName: "Welcome cocktail",
    status: "confirmed",
    kind: "event",
    detail: "19:00 - 22:00",
    balance: "Group dep.",
    startOffsetDays: 3,
    spanDays: 1
  }
];

const KIND_COLOR: Record<ReservationKind, string> = {
  reservation: colors.primary,
  group_block: "#7c3aed",
  out_of_order: "#c2413a",
  out_of_service: "#fde2e2",
  house_use: "#0ea5e9",
  day_use: "#facc15",
  maintenance_block: "#475569",
  event: "#ec4899",
  parking_booking: "#0b1026",
  meeting_room_booking: "#2563eb"
};

type CriticalAction = "Move" | "Extend" | "Split" | "Cancel" | "Block" | "Release";

const CRITICAL_ACTIONS: CriticalAction[] = ["Move", "Extend", "Split", "Cancel", "Block", "Release"];

export function LiveTimelineScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: CriticalAction; reservationId: string | null } | null>(null);

  const selected = useMemo(
    () => RESERVATIONS.find((r) => r.id === selectedId) ?? null,
    [selectedId]
  );

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.kicker}>HotelOS Flow</Text>
          <Text style={styles.title}>Live Timeline</Text>
          <Text style={styles.subtitle}>
            Rooms, parking, meeting rooms, coworking, spa, restaurant, events and other bookable inventory in one
            operational workspace.
          </Text>
        </View>

        <View style={styles.toolbar}>
          {["Today", "Rooms", "Parking", "Meeting", "Spa", "Events", "OOO", "Groups"].map((filter) => (
            <StatusChip key={filter} label={filter} tone={filter === "OOO" ? "warning" : "info"} compact />
          ))}
        </View>

        <HotelCard title="Timeline interactions" subtitle="All critical moves preview before execution">
          <View style={styles.actionGrid}>
            {[
              "Tap reservation -> bottom sheet detail",
              "Tap action chip -> confirmation modal",
              "Tap gap -> create reservation or block",
              "Tap resource -> room or space details"
            ].map((action) => (
              <Text key={action} style={styles.action}>
                {action}
              </Text>
            ))}
          </View>
        </HotelCard>

        <ScrollView horizontal style={styles.gridScroll} contentContainerStyle={{ paddingRight: 12 }}>
          <View>
            <View style={styles.timeHeaderRow}>
              <View style={styles.leadingCell}>
                <Text style={styles.headerCellText}>Resource</Text>
              </View>
              {DAYS.map((day) => (
                <View key={day} style={styles.dayHeaderCell}>
                  <Text style={styles.headerCellText}>{day}</Text>
                </View>
              ))}
            </View>
            {RESOURCES.map((resource) => {
              const blocks = RESERVATIONS.filter((r) => r.resourceId === resource.id);
              return (
                <View key={resource.id} style={styles.resourceRow}>
                  <View style={styles.leadingCell}>
                    <Text style={styles.resourceName}>{resource.label}</Text>
                    <ResourceStatusDot resourceType={resource.type} status={resource.status} />
                    {resource.capacity ? <Text style={styles.resourceMeta}>{resource.capacity}</Text> : null}
                  </View>
                  <View style={{ flexDirection: "row", position: "relative", width: CELL_WIDTH * DAY_COUNT }}>
                    {Array.from({ length: DAY_COUNT }).map((_, i) => (
                      <View key={`cell-${resource.id}-${i}`} style={styles.gridCell} />
                    ))}
                    {blocks.map((block) => (
                      <Pressable
                        key={block.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Open reservation ${block.id} for ${block.guestName}`}
                        onPress={() => setSelectedId(block.id)}
                        style={[
                          styles.block,
                          {
                            left: block.startOffsetDays * CELL_WIDTH + 4,
                            width: block.spanDays * CELL_WIDTH - 8,
                            backgroundColor: KIND_COLOR[block.kind]
                          }
                        ]}
                      >
                        <Text style={styles.blockText} numberOfLines={1}>
                          {block.guestName}
                        </Text>
                        <Text style={styles.blockSubtext} numberOfLines={1}>
                          {block.detail}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>

        <View style={styles.quickActionsBar}>
          <Text style={styles.quickActionsTitle}>Quick actions</Text>
          <View style={styles.quickActionsRow}>
            {CRITICAL_ACTIONS.map((action) => (
              <Pressable
                key={action}
                accessibilityRole="button"
                accessibilityLabel={`${action} reservation`}
                style={styles.quickActionChip}
                onPress={() => setPendingAction({ action, reservationId: selected?.id ?? null })}
              >
                <Text style={styles.quickActionText}>{action}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <SmartTipCard
          title="Timeline next best action"
          insight="Room 432 is ready, guest is pre-checked, balance is paid and only legal phone/signature remain."
          suggestedAction="Open reservation detail, complete legal data and confirm check-in."
          risk="medium"
        />
      </ScrollView>

      <Modal visible={!!selected} animationType="slide" transparent onRequestClose={() => setSelectedId(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSelectedId(null)} />
        <View style={styles.bottomSheet}>
          <View style={styles.sheetGrabber} />
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetEyebrow}>Detail</Text>
              <Text style={styles.sheetTitle}>{selected?.id ?? "Reservation"}</Text>
              {selected ? (
                <Text style={styles.sheetSubtitle}>
                  {selected.guestName} · {selected.detail} · {selected.balance}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close detail panel"
              onPress={() => setSelectedId(null)}
              style={styles.closeButton}
            >
              <Text style={styles.closeText}>X</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
            <ReservationDetailPanel
              guestName={selected?.guestName}
              reservationCode={selected?.id}
              roomLabel={RESOURCES.find((r) => r.id === selected?.resourceId)?.label}
              balance={selected ? `Balance ${selected.balance || "-"}` : undefined}
            />
            <View style={styles.criticalActionsRow}>
              {CRITICAL_ACTIONS.map((action) => (
                <Pressable
                  key={action}
                  accessibilityRole="button"
                  accessibilityLabel={`${action} reservation`}
                  style={styles.criticalActionChip}
                  onPress={() => setPendingAction({ action, reservationId: selected?.id ?? null })}
                >
                  <Text style={styles.criticalActionText}>{action}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={!!pendingAction} animationType="fade" transparent onRequestClose={() => setPendingAction(null)}>
        <View style={styles.confirmBackdrop}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>{pendingAction?.action} reservation</Text>
            <Text style={styles.confirmBody}>
              {pendingAction?.action} requires confirmation before execution. This preview will not modify any data.
            </Text>
            {pendingAction?.reservationId ? (
              <Text style={styles.confirmSubject}>{pendingAction.reservationId}</Text>
            ) : (
              <Text style={styles.confirmSubject}>No reservation selected</Text>
            )}
            <View style={styles.confirmActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel action"
                style={styles.confirmCancel}
                onPress={() => setPendingAction(null)}
              >
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Confirm ${pendingAction?.action ?? "action"}`}
                style={styles.confirmPrimary}
                onPress={() => setPendingAction(null)}
              >
                <Text style={styles.confirmPrimaryText}>{pendingAction?.action ?? "Confirm"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14, paddingBottom: 40 },
  hero: { backgroundColor: colors.primaryDark, borderRadius: 24, padding: 18, gap: 8 },
  kicker: { color: "#c7d2fe", fontWeight: "900", letterSpacing: 0 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "900", letterSpacing: 0 },
  subtitle: { color: "#e0e7ff", lineHeight: 22, letterSpacing: 0 },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  actionGrid: { gap: 8 },
  action: { color: colors.primary, fontWeight: "800", letterSpacing: 0 },
  gridScroll: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 18 },
  timeHeaderRow: { flexDirection: "row", backgroundColor: colors.primaryDark },
  leadingCell: {
    width: 140,
    padding: 10,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    backgroundColor: colors.surfaceSoft,
    gap: 4
  },
  dayHeaderCell: {
    width: CELL_WIDTH,
    padding: 10,
    justifyContent: "center",
    alignItems: "flex-start",
    borderRightWidth: 1,
    borderRightColor: "#1d2a73"
  },
  headerCellText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0, fontSize: 13 },
  resourceRow: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.line, minHeight: 78 },
  resourceName: { color: colors.ink, fontSize: 14, fontWeight: "900", letterSpacing: 0 },
  resourceMeta: { color: colors.muted, fontSize: 11, fontWeight: "800", letterSpacing: 0 },
  gridCell: {
    width: CELL_WIDTH,
    borderRightWidth: 1,
    borderRightColor: "rgba(15,23,42,0.06)"
  },
  block: {
    position: "absolute",
    top: 8,
    bottom: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: "center",
    gap: 2
  },
  blockText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0, fontSize: 13 },
  blockSubtext: { color: "rgba(255,255,255,0.85)", fontWeight: "800", letterSpacing: 0, fontSize: 11 },
  quickActionsBar: {
    backgroundColor: colors.primaryDark,
    borderRadius: 14,
    padding: 12,
    gap: 10
  },
  quickActionsTitle: { color: "#c7d2fe", fontWeight: "900", letterSpacing: 0, fontSize: 12, textTransform: "uppercase" },
  quickActionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  quickActionChip: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#c2413a",
    backgroundColor: "rgba(194,65,58,0.18)",
    justifyContent: "center"
  },
  quickActionText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 },
  backdrop: { flex: 1, backgroundColor: "rgba(11,16,38,0.32)" },
  bottomSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 18,
    gap: 12,
    maxHeight: "85%"
  },
  sheetGrabber: { width: 60, height: 6, borderRadius: 3, backgroundColor: colors.line, alignSelf: "center" },
  sheetHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  sheetEyebrow: { color: colors.muted, fontWeight: "900", letterSpacing: 0, fontSize: 12, textTransform: "uppercase" },
  sheetTitle: { color: colors.ink, fontSize: 22, fontWeight: "900", letterSpacing: 0 },
  sheetSubtitle: { color: colors.muted, lineHeight: 20, letterSpacing: 0 },
  closeButton: {
    minWidth: 36,
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceSoft,
    justifyContent: "center",
    alignItems: "center"
  },
  closeText: { color: colors.ink, fontWeight: "900", letterSpacing: 0 },
  criticalActionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  criticalActionChip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: "rgba(194,65,58,0.08)",
    justifyContent: "center"
  },
  criticalActionText: { color: colors.danger, fontWeight: "900", letterSpacing: 0 },
  confirmBackdrop: {
    flex: 1,
    backgroundColor: "rgba(11,16,38,0.42)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24
  },
  confirmCard: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 20,
    gap: 10,
    maxWidth: 380,
    width: "100%"
  },
  confirmTitle: { color: colors.ink, fontSize: 20, fontWeight: "900", letterSpacing: 0 },
  confirmBody: { color: colors.muted, lineHeight: 20, letterSpacing: 0 },
  confirmSubject: { color: colors.ink, fontWeight: "900", letterSpacing: 0 },
  confirmActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  confirmCancel: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceSoft,
    justifyContent: "center"
  },
  confirmCancelText: { color: colors.primary, fontWeight: "900", letterSpacing: 0 },
  confirmPrimary: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.danger,
    justifyContent: "center"
  },
  confirmPrimaryText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 }
});
