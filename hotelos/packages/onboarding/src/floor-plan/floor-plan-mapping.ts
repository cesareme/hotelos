export type FloorPlanMappingInput = {
  fileName: string;
  detectedText?: string;
  detectedRoomLabels?: string[];
  detectedSpaceLabels?: string[];
};

export type FloorPlanMappingPreview = {
  documentType: "floor_plan";
  fileName: string;
  suggestedFloorLabel: string | null;
  roomLabels: Array<{ label: string; confidence: number; requiresReview: boolean }>;
  spaceLabels: Array<{ label: string; resourceType: "event_space" | "meeting_room" | "technical_room" | "public_space" | "other"; confidence: number }>;
  uncertainLabels: string[];
  extractedSafetyHints: Array<{ label: string; use: "non_bookable_reference_only"; requiresSafetyReview: true }>;
  requiresHumanConfirmation: true;
  aiFloorPlanMappingIsAssistive: true;
  cannotUseForLegalSafetyWithoutReview: true;
};

function classifySpace(label: string): FloorPlanMappingPreview["spaceLabels"][number]["resourceType"] {
  if (/meeting|boardroom|conference/i.test(label)) return "meeting_room";
  if (/event|banquet|hall/i.test(label)) return "event_space";
  if (/technical|storage|electric|server|maintenance/i.test(label)) return "technical_room";
  if (/lobby|restaurant|bar|rooftop|reception/i.test(label)) return "public_space";
  return "other";
}

export function createFloorPlanMappingReview(input: FloorPlanMappingInput): FloorPlanMappingPreview {
  const detectedText = input.detectedText ?? "";
  const suggestedFloorLabel = detectedText.match(/floor\s+([a-z0-9-]+)/i)?.[0] ?? input.fileName.match(/floor[-_\s]?([a-z0-9-]+)/i)?.[0] ?? null;
  const roomLabels =
    input.detectedRoomLabels ??
    Array.from(new Set(Array.from(detectedText.matchAll(/\b\d{2,5}\b/g)).map((match) => match[0]))).filter((label) => label.length >= 3);
  const spaceLabels = input.detectedSpaceLabels ?? Array.from(new Set(Array.from(detectedText.matchAll(/\b(?:restaurant|parking|meeting room|rooftop|lobby|storage|technical room)\b/gi)).map((match) => match[0])));
  const uncertainLabels = roomLabels.filter((label) => !/^\d{3,5}$/.test(label));

  return {
    documentType: "floor_plan",
    fileName: input.fileName,
    suggestedFloorLabel,
    roomLabels: roomLabels.map((label) => ({
      label,
      confidence: /^\d{3,5}$/.test(label) ? 0.76 : 0.48,
      requiresReview: true
    })),
    spaceLabels: spaceLabels.map((label) => ({
      label,
      resourceType: classifySpace(label),
      confidence: 0.62
    })),
    uncertainLabels,
    extractedSafetyHints: Array.from(new Set(Array.from(detectedText.matchAll(/\b(?:emergency exit|fire exit|evacuation)\b/gi)).map((match) => match[0]))).map((label) => ({
      label,
      use: "non_bookable_reference_only",
      requiresSafetyReview: true
    })),
    requiresHumanConfirmation: true,
    aiFloorPlanMappingIsAssistive: true,
    cannotUseForLegalSafetyWithoutReview: true
  };
}
