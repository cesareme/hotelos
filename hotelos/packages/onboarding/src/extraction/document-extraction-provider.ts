export type DocumentExtractionProviderCode =
  | "azure_document_intelligence"
  | "google_document_ai"
  | "aws_textract"
  | "openai_vision"
  | "manual";

export type ExtractDocumentInput = {
  fileId: string;
  objectKey: string;
  fileType?: string;
};

export type ExtractedDocumentText = {
  text: string;
  confidence: number;
  sourceReferences: string[];
};

export type ExtractedTable = {
  name?: string;
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  confidence: number;
};

export type ExtractedKeyValuePair = {
  key: string;
  value: string | number | null;
  confidence: number;
  sourceReference?: string;
};

export type DocumentClassificationResult = {
  documentType:
    | "room_list"
    | "rate_sheet"
    | "future_reservations"
    | "guest_list"
    | "channel_mapping"
    | "floor_plan"
    | "revenue_history_forecast_report"
    | "legal_document"
    | "unknown";
  confidence: number;
  warnings: string[];
};

export interface DocumentExtractionProvider {
  providerCode: DocumentExtractionProviderCode;
  extractText(input: ExtractDocumentInput): Promise<ExtractedDocumentText>;
  extractTables(input: ExtractDocumentInput): Promise<ExtractedTable[]>;
  extractKeyValuePairs(input: ExtractDocumentInput): Promise<ExtractedKeyValuePair[]>;
  classifyDocument(input: ExtractDocumentInput): Promise<DocumentClassificationResult>;
}

export const DEFAULT_EXTRACTION_STRATEGY = [
  "Use structured spreadsheet parsing for CSV/XLSX.",
  "Use document OCR/table extraction for PDFs.",
  "Use OpenAI Structured Outputs for semantic schema mapping.",
  "Use OpenAI vision only for floor plans or visual documents when OCR is insufficient.",
  "AI must output null plus missingData for unknown values and never invent source data."
];
