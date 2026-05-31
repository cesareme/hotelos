// Deterministic document classifier. Uses header tokens + keyword heuristics
// to decide what an uploaded onboarding file is. In real (LLM) mode this is
// where a model would classify; the stub keeps it explainable and offline.
//
// The classifier returns the filename as a fallback signal but prefers
// content-derived evidence when available.

import { detectDelimiter } from "./csv-parser.js";
import type { ClassificationResult, ClassifyInput, DetectedDocumentType } from "./types.js";

type Rule = {
  type: DetectedDocumentType;
  headerTokens: string[][]; // groups of tokens; a group matches if ALL present
  keywords: string[];
};

const RULES: Rule[] = [
  {
    type: "revenue_history_forecast_report",
    headerTokens: [["totalrevenue"], ["averagerate"], ["occ"]],
    keywords: ["history", "forecast", "revenue", "occ.", "average rate", "house use"]
  },
  {
    type: "room_list",
    headerTokens: [["room", "type"], ["roomnumber"], ["roomtype", "floor"]],
    keywords: ["room list", "rooms", "floor", "wing"]
  },
  {
    type: "rate_sheet",
    headerTokens: [["ratecode"], ["rateplan"], ["rate", "currency"], ["baseprice"]],
    keywords: ["rate plan", "rate sheet", "bar", "rate code", "tariff"]
  },
  {
    type: "reservation_export",
    headerTokens: [["arrival", "departure"], ["checkin", "checkout"], ["bookingref"], ["confirmation", "guest"]],
    keywords: ["reservation", "booking", "arrival", "departure", "check-in"]
  },
  {
    type: "guest_export",
    headerTokens: [["firstname", "surname"], ["firstname", "lastname"], ["email", "nationality"], ["passport"]],
    keywords: ["guest list", "guests", "nationality", "passport", "document"]
  },
  {
    type: "channel_mapping",
    headerTokens: [["channel", "code"], ["ota"], ["bookingcom"]],
    keywords: ["channel", "booking.com", "expedia", "airbnb", "ota", "mapping"]
  }
];

function normaliseToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readHeaderTokens(content: string): string[] {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return [];
  const delimiter = detectDelimiter(content);
  return firstLine
    .split(delimiter)
    .map((cell) => normaliseToken(cell))
    .filter((token) => token.length > 0);
}

function filenameSignal(fileName: string): DetectedDocumentType | undefined {
  const name = fileName.toLowerCase();
  if (name.includes("revenue") || name.includes("history") || name.includes("forecast")) {
    return "revenue_history_forecast_report";
  }
  if (name.includes("floor")) return "floor_plan";
  if (name.includes("room")) return "room_list";
  if (name.includes("rate") || name.includes("tariff")) return "rate_sheet";
  if (name.includes("reservation") || name.includes("booking")) return "reservation_export";
  if (name.includes("guest")) return "guest_export";
  if (name.includes("channel")) return "channel_mapping";
  return undefined;
}

export function classifyDocument(input: ClassifyInput): ClassificationResult {
  const signals: string[] = [];
  const warnings: string[] = [];
  const headerTokens = new Set(readHeaderTokens(input.content));
  const haystack = input.content.toLowerCase();

  let best: { type: DetectedDocumentType; score: number } | undefined;
  for (const rule of RULES) {
    let score = 0;
    for (const group of rule.headerTokens) {
      if (group.every((token) => headerTokens.has(token))) {
        score += 2; // header evidence is strong
      }
    }
    for (const keyword of rule.keywords) {
      if (haystack.includes(keyword)) {
        score += 0.5;
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { type: rule.type, score };
    }
  }

  const fileSignal = filenameSignal(input.fileName);
  if (fileSignal) signals.push(`filename:${fileSignal}`);

  if (best) {
    signals.push(`content:${best.type} (score ${best.score})`);
    // Confidence scales with score; cap at 0.97. Header-backed matches start
    // higher than keyword-only matches.
    const confidence = Math.min(0.97, 0.55 + best.score * 0.1);
    if (fileSignal && fileSignal !== best.type && best.score < 2) {
      warnings.push(`Filename suggests "${fileSignal}" but content looks like "${best.type}".`);
    }
    return { detectedDocumentType: best.type, confidence: round2(confidence), warnings, signals };
  }

  // No content evidence — fall back to filename only.
  if (fileSignal) {
    warnings.push("Classification based on filename only; content gave no strong signal.");
    return { detectedDocumentType: fileSignal, confidence: 0.6, warnings, signals };
  }

  warnings.push("Could not confidently classify the document; treating as generic export.");
  return {
    detectedDocumentType: "generic_pms_export",
    confidence: 0.4,
    warnings,
    signals
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
