import { Pressable, StyleSheet, Text, View } from "react-native";
import { HotelCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../../theme/colors";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";
import { checkInGuest } from "./checkInFlowData";

export function GuestSignatureScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="signature"
      title="Guest signature"
      subtitle="The signed entry form is captured after confirmation and before final check-in execution."
      stateLabel="signature"
    >
      <HotelCard title="Entry form" subtitle={`${checkInGuest.name} - ${checkInGuest.reservationCode}`}>
        <View style={styles.signaturePad}>
          <Text style={styles.signatureText}>Signature area</Text>
        </View>
        <View style={styles.row}>
          <StatusChip label="signatureRequired: true" tone="warning" />
          <StatusChip label="template configured" tone="success" />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Capture guest signature" style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Capture signature</Text>
        </Pressable>
      </HotelCard>
    </CheckInFlowScaffold>
  );
}

const styles = StyleSheet.create({
  signaturePad: {
    minHeight: 170,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSoft
  },
  signatureText: {
    color: colors.muted,
    fontWeight: "900",
    letterSpacing: 0
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center"
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "900",
    letterSpacing: 0
  }
});
