export type RoomWalkRoomSuggestion = {
  roomNumber: string;
  floorLabel: string | null;
  zoneLabel: string | null;
  roomTypeLabel: string | null;
  resourceType: "room" | "storage" | "other";
  status: "active" | "out_of_order" | "non_bookable_review";
  confidence: number;
};

export type RoomWalkSetupPreview = {
  sourceTranscript: string;
  suggestions: RoomWalkRoomSuggestion[];
  warnings: string[];
  missingData: string[];
  confidence: number;
  requiresHumanConfirmation: true;
  applyBlockedUntilApproved: true;
};

const ROOM_TYPE_PATTERNS = [
  { pattern: /double standard/i, label: "Double Standard" },
  { pattern: /superior/i, label: "Superior" },
  { pattern: /suite/i, label: "Suite" },
  { pattern: /single/i, label: "Single" },
  { pattern: /storage/i, label: "Storage" }
] as const;

function detectRoomType(fragment: string) {
  return ROOM_TYPE_PATTERNS.find((candidate) => candidate.pattern.test(fragment))?.label ?? null;
}

function expandRange(start: number, end: number) {
  const direction = start <= end ? 1 : -1;
  const rooms: string[] = [];
  for (let value = start; direction === 1 ? value <= end : value >= end; value += direction) {
    rooms.push(String(value));
  }
  return rooms;
}

export function parseRoomWalkTranscript(transcript: string): RoomWalkSetupPreview {
  const floorLabel = transcript.match(/floor\s+([a-z0-9-]+)/i)?.[1] ?? null;
  const zoneLabel = transcript.match(/\b(east|west|north|south|central)\s+wing\b/i)?.[0] ?? null;
  const warnings: string[] = [];
  const suggestions: RoomWalkRoomSuggestion[] = [];
  const rangeMatcher = /rooms?\s+(\d{2,5})\s+(?:to|-)\s+(\d{2,5})([^.]+)/gi;
  let rangeMatch: RegExpExecArray | null;

  while ((rangeMatch = rangeMatcher.exec(transcript))) {
    const roomTypeLabel = detectRoomType(rangeMatch[3]);
    const status = /out of order/i.test(rangeMatch[3]) ? "out_of_order" : "active";
    for (const roomNumber of expandRange(Number(rangeMatch[1]), Number(rangeMatch[2]))) {
      suggestions.push({
        roomNumber,
        floorLabel,
        zoneLabel,
        roomTypeLabel,
        resourceType: roomTypeLabel === "Storage" ? "storage" : "room",
        status,
        confidence: roomTypeLabel ? 0.88 : 0.68
      });
    }
  }

  const singleRoomMatcher = /(?:room\s+)?(\d{2,5})\s+(?:is|are)\s+([^.]+)/gi;
  let singleRoomMatch: RegExpExecArray | null;
  while ((singleRoomMatch = singleRoomMatcher.exec(transcript))) {
    const roomNumber = singleRoomMatch[1];
    if (suggestions.some((suggestion) => suggestion.roomNumber === roomNumber)) {
      continue;
    }
    const fragment = singleRoomMatch[2];
    const roomTypeLabel = detectRoomType(fragment);
    const isStorage = /storage/i.test(fragment);
    const outOfOrder = /out of order/i.test(fragment);
    suggestions.push({
      roomNumber,
      floorLabel,
      zoneLabel,
      roomTypeLabel: isStorage ? "Storage" : roomTypeLabel,
      resourceType: isStorage ? "storage" : "room",
      status: outOfOrder ? "out_of_order" : isStorage ? "non_bookable_review" : "active",
      confidence: roomTypeLabel || isStorage || outOfOrder ? 0.82 : 0.62
    });
  }

  if (!floorLabel) {
    warnings.push("Floor was not detected. Assign a floor before applying the property blueprint.");
  }
  if (suggestions.length === 0) {
    warnings.push("No room numbers were detected from the transcript.");
  }

  return {
    sourceTranscript: transcript,
    suggestions,
    warnings,
    missingData: suggestions.some((suggestion) => !suggestion.roomTypeLabel && suggestion.resourceType === "room") ? ["roomTypeLabel"] : [],
    confidence: suggestions.length > 0 ? Math.min(0.92, suggestions.reduce((sum, suggestion) => sum + suggestion.confidence, 0) / suggestions.length) : 0,
    requiresHumanConfirmation: true,
    applyBlockedUntilApproved: true
  };
}
