// Shared, framework-free contracts for the onboarding AI engines.
// These shapes are part of the Sprint 52/53 contract — keep them stable.

export type ExtractedEntity = {
  id: string;
  entityType: string;
  /** Where this entity came from in the source (e.g. "row:3" / "line:12"). */
  sourceRef: string;
  /** 0..1 — how many of the expected fields for this entity type matched. */
  confidence: number;
  fields: Record<string, unknown>;
  warnings: string[];
};

export type ExtractionSummary = {
  total: number;
  byType: Record<string, number>;
  avgConfidence: number;
  warningsCount: number;
};

export type ExtractionResult = {
  entities: ExtractedEntity[];
  summary: ExtractionSummary;
};

export type DetectedDocumentType =
  | "room_list"
  | "rate_sheet"
  | "reservation_export"
  | "guest_export"
  | "channel_mapping"
  | "revenue_history_forecast_report"
  | "floor_plan"
  | "generic_pms_export"
  | "unknown";

export type ExtractInput = {
  fileName: string;
  fileType: string;
  /** Raw uploaded text content (CSV/TSV/JSON). */
  content: string;
  detectedDocumentType?: DetectedDocumentType | string;
};

export type ClassifyInput = {
  fileName: string;
  fileType: string;
  content: string;
};

export type ClassificationResult = {
  detectedDocumentType: DetectedDocumentType;
  confidence: number;
  warnings: string[];
  signals: string[];
};

export type MappingType = "room_type" | "rate_plan" | "channel" | "reservation_field";

export type MappingSuggestion = {
  id: string;
  mappingType: MappingType;
  sourceValue: string;
  targetValue: string;
  confidence: number;
  status: "pending";
  rationale: string;
};

export type MappingTarget = "room_type" | "rate_plan" | "channel" | "auto";

export type GenerateMappingsInput = {
  entities: ExtractedEntity[];
  target?: MappingTarget;
};
