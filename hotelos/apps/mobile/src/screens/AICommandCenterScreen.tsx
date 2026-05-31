import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ConfirmationCard as ConfirmationCardData } from "@hotelos/shared";
import { CommandDock, ConfidenceMeter, ConfirmationCard, HotelCard, RiskBadge, StatusChip } from "@hotelos/ui";
import { Camera, FileSearch, ListChecks, ShieldCheck } from "lucide-react-native";
import { executeCheckInConfirmation, requestCheckInFromScan } from "../services/api";
import { scanDocumentForGuestRegister, startVoiceCommand, stopVoiceCommand } from "../services/nativeCapabilities";
import { colors } from "../theme/colors";
import { checkInSteps } from "./ai/checkin";

type AiState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "tool_preview"
  | "confirmation_required"
  | "executing"
  | "success"
  | "failed"
  | "human_review_required";

export function AICommandCenterScreen() {
  const [command, setCommand] = useState("Check in this customer in room 432");
  const [confirmationId, setConfirmationId] = useState<string | undefined>();
  const [card, setCard] = useState<ConfirmationCardData | undefined>();
  const [state, setState] = useState<AiState>("idle");
  const [result, setResult] = useState("Ready for voice, camera, or text command.");
  const [confidence, setConfidence] = useState(94);

  async function runFlagshipFlow() {
    setState("listening");
    setResult("Listening to receptionist command.");
    await startVoiceCommand("en-GB");

    setState("transcribing");
    const voice = await stopVoiceCommand();
    setCommand(voice.transcript);
    setConfidence(Math.round((voice.confidence ?? 0.94) * 100));

    setState("thinking");
    const document = await scanDocumentForGuestRegister();
    setResult("Document fields extracted. ID image discarded and deletion event prepared.");

    const response = await requestCheckInFromScan({
      propertyId: "prop_123",
      transcript: voice.transcript,
      roomNumber: "432",
      documentExtractedFields: document.fields,
      documentImageStored: document.imageStored,
      idImageDiscarded: document.imageDiscarded
    });

    setConfirmationId(response.confirmationId);
    setCard(response.card);
    setState(response.status === "confirmation_required" ? "confirmation_required" : "failed");
    setResult(response.status === "confirmation_required" ? "Preview ready. Human confirmation and signature required." : "Command could not be prepared.");
  }

  async function confirmCheckIn() {
    if (!confirmationId) return;
    setState("executing");
    setResult("Executing permissioned backend tools.");
    const response = await executeCheckInConfirmation(confirmationId);
    setState(response.status === "executed" ? "success" : "failed");
    setResult(response.status === "executed" ? "Checked in, room occupied, SES.HOSPEDAJES queued, audit chain sealed." : response.status);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>AI Front Desk</Text>
          <Text style={styles.title}>Command Center</Text>
        </View>
        <StatusChip label={state} tone={state === "failed" ? "error" : state === "success" ? "success" : "ai"} />
      </View>

      <CommandDock
        value={command}
        onChangeText={setCommand}
        onSubmit={runFlagshipFlow}
        onVoice={runFlagshipFlow}
        onCamera={runFlagshipFlow}
        state={state === "idle" ? "Ask, scan, or dictate" : result}
        confidence={confidence}
        riskLevel="high"
      />

      <HotelCard title="Interpreted intent" subtitle="Every AI action exposes confidence, risk and next step" tone="ai">
        <View style={styles.intentGrid}>
          <View style={styles.intentCell}><Text style={styles.meta}>Intent</Text><Text style={styles.intentValue}>CHECK_IN_GUEST</Text></View>
          <View style={styles.intentCell}><Text style={styles.meta}>Room</Text><Text style={styles.intentValue}>432</Text></View>
          <View style={styles.intentCell}><Text style={styles.meta}>Tool path</Text><Text style={styles.intentValue}>scan - match - validate - confirm</Text></View>
          <View style={styles.intentCell}><Text style={styles.meta}>Approval</Text><Text style={styles.intentValue}>Reception + Signature</Text></View>
        </View>
        <View style={styles.badgeRow}>
          <ConfidenceMeter value={confidence} />
          <RiskBadge riskLevel="high" />
        </View>
      </HotelCard>

      {card ? (
        <ConfirmationCard
          title={card.title}
          summary={card.summary}
          riskLevel="high"
          warnings={card.warnings}
          actions={card.actions}
          primaryActionLabel="Confirm check-in"
          secondaryActionLabel="Cancel"
          onCancel={() => {
            setCard(undefined);
            setState("idle");
            setResult("Confirmation cancelled.");
          }}
          onConfirm={confirmCheckIn}
          disabled={state === "executing"}
        />
      ) : null}

      <HotelCard title="Voice check-in flow" subtitle="Dedicated screens for the end-to-end demo">
        <View style={styles.flowScreenGrid}>
          {checkInSteps.map((step) => (
            <View key={step.code} style={styles.flowScreenCell}>
              <Text style={styles.meta}>{step.label}</Text>
              <Text style={styles.intentValue}>{step.code}</Text>
            </View>
          ))}
        </View>
      </HotelCard>

      <View style={styles.cardGrid}>
        <HotelCard title="Suggested commands" subtitle="Context-aware operations">
          {[
            "Move guest in 204 to 308.",
            "Charge two breakfasts to room 432.",
            "Block room 108 because the AC is broken.",
            "Show arrivals with unpaid balances."
          ].map((suggestion) => (
            <Pressable key={suggestion} accessibilityRole="button" accessibilityLabel={`Use command ${suggestion}`} onPress={() => setCommand(suggestion)} style={styles.suggestion}>
              <Text style={styles.suggestionText}>{suggestion}</Text>
            </Pressable>
          ))}
        </HotelCard>

        <HotelCard title="Recent AI actions" subtitle="Auditable and reversible by design">
          <View style={styles.auditLine}><ShieldCheck color={colors.success} size={18} /><Text style={styles.auditText}>ID_IMAGE_DISCARDED logged</Text></View>
          <View style={styles.auditLine}><FileSearch color={colors.electric} size={18} /><Text style={styles.auditText}>Room 432 validation previewed</Text></View>
          <View style={styles.auditLine}><Camera color={colors.accent} size={18} /><Text style={styles.auditText}>Camera OCR kept temporary</Text></View>
          <View style={styles.auditLine}><ListChecks color={colors.warning} size={18} /><Text style={styles.auditText}>Pending confirmation required</Text></View>
        </HotelCard>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 18
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12
  },
  kicker: {
    color: colors.muted,
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: 0
  },
  intentGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  intentCell: {
    minWidth: 134,
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 12,
    backgroundColor: colors.surfaceSoft
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0
  },
  intentValue: {
    marginTop: 4,
    color: colors.ink,
    fontWeight: "900",
    letterSpacing: 0
  },
  badgeRow: {
    gap: 10
  },
  flowScreenGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  flowScreenCell: {
    minWidth: 104,
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 10,
    backgroundColor: colors.surfaceSoft
  },
  cardGrid: {
    gap: 12
  },
  suggestion: {
    minHeight: 44,
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  suggestionText: {
    color: colors.ink,
    fontWeight: "700",
    letterSpacing: 0
  },
  auditLine: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  auditText: {
    color: colors.ink,
    letterSpacing: 0
  }
});
