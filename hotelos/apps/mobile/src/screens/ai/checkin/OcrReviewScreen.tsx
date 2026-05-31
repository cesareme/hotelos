import { StyleSheet, Text, View } from "react-native";
import { ConfidenceMeter, HotelCard, StatusChip } from "@hotelos/ui";
import { colors } from "../../../theme/colors";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";
import { ocrFields } from "./checkInFlowData";

export function OcrReviewScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="ocr"
      title="OCR review"
      subtitle="Reception reviews extracted fields and sees uncertainty before confirming guest data."
      stateLabel="review"
    >
      <HotelCard title="Extracted guest register fields" subtitle="Uncertain fields stay visible">
        <View style={styles.grid}>
          {ocrFields.map((field) => (
            <View key={field.label} style={styles.field}>
              <Text style={styles.label}>{field.label}</Text>
              <Text style={styles.value}>{field.value}</Text>
              {field.confidence > 0 ? <ConfidenceMeter value={field.confidence} label="Confidence" /> : <StatusChip label="missing" tone="warning" />}
            </View>
          ))}
        </View>
      </HotelCard>
      <HotelCard title="Deletion log" subtitle="Created before the confirmation card">
        <StatusChip label="ID_IMAGE_DISCARDED" tone="success" />
        <Text style={styles.detail}>Original document image has been discarded. Required fields remain available for the guest register.</Text>
      </HotelCard>
    </CheckInFlowScaffold>
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: 10
  },
  field: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 12,
    gap: 8,
    backgroundColor: colors.surfaceSoft
  },
  label: {
    color: colors.muted,
    fontWeight: "900",
    letterSpacing: 0
  },
  value: {
    color: colors.ink,
    fontWeight: "900",
    letterSpacing: 0
  },
  detail: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  }
});
