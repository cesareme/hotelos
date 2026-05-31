// Deterministic onboarding extraction engine. Parses raw uploaded text
// (CSV/TSV/JSON) into typed ExtractedEntity records. Pure + framework-free
// so it can run inside both apps/api (stub mode) and apps/ai-gateway.
//
// Rules (Sprint 52):
//   - NEVER invent values. Missing expected fields -> lower confidence + warning.
//   - Confidence = fraction of expected fields that matched.

import { parseDelimited } from "./csv-parser.js";
import type {
  DetectedDocumentType,
  ExtractInput,
  ExtractedEntity,
  ExtractionResult,
  ExtractionSummary
} from "./types.js";

/** A target field plus the header tokens (lowercased) we accept for it. */
type FieldSpec = {
  field: string;
  aliases: string[];
  required: boolean;
};

type EntityProfile = {
  entityType: string;
  fields: FieldSpec[];
};

// Header heuristics per entity type. `aliases` are matched against normalised
// header tokens (lowercased, non-alphanumerics stripped). Order matters for
// scoring only in that all specs are evaluated independently.
const PROFILES: Record<string, EntityProfile> = {
  room: {
    entityType: "room",
    fields: [
      { field: "roomNumber", aliases: ["room", "roomno", "roomnumber", "no", "number", "rmno"], required: true },
      { field: "roomType", aliases: ["roomtype", "type", "category", "class"], required: true },
      { field: "floor", aliases: ["floor", "level", "fl"], required: false },
      { field: "building", aliases: ["building", "block", "wing", "zone"], required: false },
      { field: "status", aliases: ["status", "state", "condition"], required: false }
    ]
  },
  rate_plan: {
    entityType: "rate_plan",
    fields: [
      { field: "code", aliases: ["code", "ratecode", "rateplan", "plan", "planid"], required: true },
      { field: "name", aliases: ["name", "ratename", "description", "label"], required: true },
      { field: "basePrice", aliases: ["price", "baseprice", "rate", "amount", "value"], required: false },
      { field: "currency", aliases: ["currency", "ccy", "curr"], required: false }
    ]
  },
  reservation: {
    entityType: "reservation",
    fields: [
      { field: "code", aliases: ["code", "reservation", "resno", "bookingref", "booking", "confirmation", "reference"], required: true },
      { field: "guestName", aliases: ["guest", "guestname", "name", "customer"], required: true },
      { field: "arrival", aliases: ["arrival", "arrivaldate", "checkin", "from", "startdate"], required: true },
      { field: "departure", aliases: ["departure", "departuredate", "checkout", "to", "enddate"], required: true },
      { field: "roomType", aliases: ["roomtype", "type", "category"], required: false },
      { field: "amount", aliases: ["amount", "total", "price", "value", "revenue"], required: false }
    ]
  },
  guest: {
    entityType: "guest",
    fields: [
      { field: "firstName", aliases: ["firstname", "first", "givenname", "name"], required: true },
      { field: "surname", aliases: ["surname", "lastname", "last", "familyname"], required: true },
      { field: "email", aliases: ["email", "mail", "emailaddress"], required: false },
      { field: "documentNumber", aliases: ["document", "documentnumber", "dni", "passport", "idnumber", "nif"], required: false },
      { field: "nationality", aliases: ["nationality", "country", "countrycode"], required: false }
    ]
  }
};

const DOC_TYPE_TO_PROFILE: Record<string, string> = {
  room_list: "room",
  rate_sheet: "rate_plan",
  reservation_export: "reservation",
  future_reservations: "reservation",
  guest_export: "guest",
  guest_list: "guest"
};

function normaliseToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isJsonContent(input: ExtractInput): boolean {
  if (input.fileType.includes("json") || input.fileName.toLowerCase().endsWith(".json")) {
    return true;
  }
  const trimmed = input.content.trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("{");
}

/** Build a header -> field map for the given profile by matching aliases. */
function mapColumns(header: string[], profile: EntityProfile): Map<number, string> {
  const columnToField = new Map<number, string>();
  const usedFields = new Set<string>();
  header.forEach((rawHeader, index) => {
    const token = normaliseToken(rawHeader);
    if (!token) return;
    for (const spec of profile.fields) {
      if (usedFields.has(spec.field)) continue;
      if (spec.aliases.includes(token)) {
        columnToField.set(index, spec.field);
        usedFields.add(spec.field);
        return;
      }
    }
  });
  return columnToField;
}

function buildEntityFromRow(args: {
  profile: EntityProfile;
  columnToField: Map<number, string>;
  header: string[];
  row: string[];
  sourceRef: string;
}): ExtractedEntity {
  const { profile, columnToField, header, row, sourceRef } = args;
  const fields: Record<string, unknown> = {};
  const warnings: string[] = [];

  // Pull mapped values (never invent — only copy what exists & is non-empty).
  for (const [columnIndex, field] of columnToField.entries()) {
    const value = row[columnIndex];
    if (value !== undefined && value !== "") {
      fields[field] = value;
    }
  }

  // Confidence = matched expected fields / total expected fields.
  const expected = profile.fields;
  let matched = 0;
  for (const spec of expected) {
    if (fields[spec.field] !== undefined) {
      matched += 1;
    } else if (spec.required) {
      warnings.push(`Missing required field "${spec.field}" (not inventing a value).`);
    }
  }
  const confidence = expected.length === 0 ? 0 : round2(matched / expected.length);

  return {
    id: deterministicId(`${profile.entityType}:${sourceRef}`),
    entityType: profile.entityType,
    sourceRef,
    confidence,
    fields,
    warnings
  };
}

/** Best-effort generic record: keep every non-empty column as-is. */
function buildGenericRecord(header: string[], row: string[], sourceRef: string): ExtractedEntity {
  const fields: Record<string, unknown> = {};
  const warnings: string[] = [];
  header.forEach((rawHeader, index) => {
    const key = rawHeader.trim() || `column${index + 1}`;
    const value = row[index];
    if (value !== undefined && value !== "") {
      fields[key] = value;
    }
  });
  const nonEmpty = Object.keys(fields).length;
  if (nonEmpty === 0) {
    warnings.push("Row had no parseable values.");
  }
  // Generic records have moderate confidence: we kept what we found but did
  // not semantically classify the entity.
  const confidence = header.length === 0 ? 0 : round2(Math.min(0.6, nonEmpty / header.length * 0.6));
  return {
    id: deterministicId(`record:${sourceRef}`),
    entityType: "record",
    sourceRef,
    confidence,
    fields,
    warnings
  };
}

function extractFromDelimited(input: ExtractInput, profileKey: string | undefined): ExtractedEntity[] {
  const { header, rows } = parseDelimited(input.content);
  if (header.length === 0) return [];
  const profile = profileKey ? PROFILES[profileKey] : undefined;
  return rows.map((row, rowIndex) => {
    const sourceRef = `row:${rowIndex + 1}`;
    if (!profile) {
      return buildGenericRecord(header, row, sourceRef);
    }
    const columnToField = mapColumns(header, profile);
    return buildEntityFromRow({ profile, columnToField, header, row, sourceRef });
  });
}

function extractFromJson(input: ExtractInput, profileKey: string | undefined): ExtractedEntity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    return [];
  }
  const array = Array.isArray(parsed) ? parsed : [parsed];
  const profile = profileKey ? PROFILES[profileKey] : undefined;
  return array
    .map((item, index) => {
      const sourceRef = `item:${index}`;
      if (item === null || typeof item !== "object") {
        return buildGenericRecord(["value"], [String(item)], sourceRef);
      }
      const record = item as Record<string, unknown>;
      if (!profile) {
        const fields = pruneEmpty(record);
        return {
          id: deterministicId(`record:${sourceRef}`),
          entityType: "record",
          sourceRef,
          confidence: round2(Object.keys(fields).length > 0 ? 0.6 : 0),
          fields,
          warnings: Object.keys(fields).length === 0 ? ["Object had no usable values."] : []
        } satisfies ExtractedEntity;
      }
      return buildEntityFromJsonObject(profile, record, sourceRef);
    });
}

function buildEntityFromJsonObject(
  profile: EntityProfile,
  record: Record<string, unknown>,
  sourceRef: string
): ExtractedEntity {
  // Normalise the object's keys once for alias lookups.
  const normalisedKeys = new Map<string, string>();
  for (const key of Object.keys(record)) {
    normalisedKeys.set(normaliseToken(key), key);
  }
  const fields: Record<string, unknown> = {};
  const warnings: string[] = [];
  let matched = 0;
  for (const spec of profile.fields) {
    let sourceKey: string | undefined;
    for (const alias of spec.aliases) {
      if (normalisedKeys.has(alias)) {
        sourceKey = normalisedKeys.get(alias);
        break;
      }
    }
    const value = sourceKey ? record[sourceKey] : undefined;
    if (value !== undefined && value !== null && value !== "") {
      fields[spec.field] = value;
      matched += 1;
    } else if (spec.required) {
      warnings.push(`Missing required field "${spec.field}" (not inventing a value).`);
    }
  }
  const confidence = profile.fields.length === 0 ? 0 : round2(matched / profile.fields.length);
  return {
    id: deterministicId(`${profile.entityType}:${sourceRef}`),
    entityType: profile.entityType,
    sourceRef,
    confidence,
    fields,
    warnings
  };
}

function pruneEmpty(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

export function extractEntities(input: ExtractInput): ExtractionResult {
  const profileKey = input.detectedDocumentType
    ? DOC_TYPE_TO_PROFILE[input.detectedDocumentType]
    : undefined;

  let entities: ExtractedEntity[];
  if (!input.content || input.content.trim().length === 0) {
    entities = [];
  } else if (isJsonContent(input)) {
    entities = extractFromJson(input, profileKey);
  } else {
    entities = extractFromDelimited(input, profileKey);
  }

  return { entities, summary: summarise(entities) };
}

export function summarise(entities: ExtractedEntity[]): ExtractionSummary {
  const byType: Record<string, number> = {};
  let confidenceSum = 0;
  let warningsCount = 0;
  for (const entity of entities) {
    byType[entity.entityType] = (byType[entity.entityType] ?? 0) + 1;
    confidenceSum += entity.confidence;
    warningsCount += entity.warnings.length;
  }
  const total = entities.length;
  return {
    total,
    byType,
    avgConfidence: total === 0 ? 0 : round2(confidenceSum / total),
    warningsCount
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Stable id derived from a seed so re-extracting identical content is
// idempotent (no random churn). FNV-1a 32-bit hash -> hex.
function deterministicId(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ent_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export const KNOWN_DOCUMENT_PROFILES = Object.keys(PROFILES);
export type { DetectedDocumentType };
