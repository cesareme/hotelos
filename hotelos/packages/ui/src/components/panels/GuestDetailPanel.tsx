import { Text } from "react-native";
import { SmartTipCard } from "../SmartTipCard.js";
import { ContextDetailPanel } from "./ContextDetailPanel.js";

export function GuestDetailPanel() {
  return (
    <ContextDetailPanel title="Guest profile" subtitle="Maria Lopez Garcia · VIP preference signals">
      <Text>Preferences, consent, stay history, spend, messages, complaints and loyalty status stay visible here.</Text>
      <SmartTipCard
        title="Personalization"
        insight="Guest previously requested quiet high floor and late checkout."
        suggestedAction="Offer late checkout if occupancy remains below threshold."
        risk="low"
      />
    </ContextDetailPanel>
  );
}
