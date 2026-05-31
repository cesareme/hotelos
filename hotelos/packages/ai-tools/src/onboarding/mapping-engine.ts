// Deterministic mapping engine. Takes extracted entities and proposes
// HotelOS target values for room types, rate plans and channels using a
// small built-in catalog of aliases + Levenshtein fuzzy matching.
//
// Confidence model (Sprint 52):
//   - exact alias hit         -> 0.95
//   - fuzzy hit (close enough) -> 0.7
//   - no match                 -> 0.3 + warning

import type {
  ExtractedEntity,
  GenerateMappingsInput,
  MappingSuggestion,
  MappingType
} from "./types.js";

type CatalogEntry = {
  target: string;
  aliases: string[]; // normalised
};

// Built-in HotelOS catalog. Aliases are stored normalised (uppercase, stripped).
const ROOM_TYPE_CATALOG: CatalogEntry[] = [
  { target: "Double Room", aliases: ["DBL", "DOUBLE", "DBLSTD", "DOUBLESTANDARD", "DOUBLEROOM", "DOB"] },
  { target: "Twin Room", aliases: ["TWIN", "TWN", "TWINROOM"] },
  { target: "Single Room", aliases: ["SGL", "SINGLE", "SNG", "SINGLEROOM"] },
  { target: "Suite", aliases: ["SUITE", "STE", "JUNIORSUITE", "JRSUITE", "SUITEROOM"] }
];

const RATE_CODE_CATALOG: CatalogEntry[] = [
  { target: "Flexible BAR", aliases: ["BAR", "FLEX", "FLEXIBLE", "BESTAVAILABLE", "RACK"] },
  { target: "Non-refundable", aliases: ["NREF", "NONREF", "NONREFUNDABLE", "NR", "ADV", "ADVANCE"] },
  { target: "Corporate", aliases: ["CORP", "CORPORATE", "COMPANY", "NEG"] }
];

const CHANNEL_CATALOG: CatalogEntry[] = [
  { target: "Booking.com", aliases: ["BDC", "BOOKING", "BOOKINGCOM", "BCOM"] },
  { target: "Expedia", aliases: ["EXP", "EXPEDIA", "EAN"] },
  { target: "Airbnb", aliases: ["AIRBNB", "ABB", "AIR"] }
];

const CATALOGS: Record<Exclude<MappingType, "reservation_field">, CatalogEntry[]> = {
  room_type: ROOM_TYPE_CATALOG,
  rate_plan: RATE_CODE_CATALOG,
  channel: CHANNEL_CATALOG
};

function normalise(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Classic iterative Levenshtein distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

type MatchResult = {
  target: string;
  confidence: number;
  matchType: "exact" | "fuzzy" | "none";
  matchedAlias?: string;
};

function matchToCatalog(rawValue: string, catalog: CatalogEntry[]): MatchResult {
  const normalised = normalise(rawValue);
  if (!normalised) {
    return { target: "", confidence: 0.3, matchType: "none" };
  }

  // 1) Exact alias hit.
  for (const entry of catalog) {
    if (entry.aliases.includes(normalised)) {
      return { target: entry.target, confidence: 0.95, matchType: "exact", matchedAlias: normalised };
    }
  }

  // 2) Fuzzy: best alias by edit distance, accept if close enough.
  let best: { target: string; alias: string; distance: number } | undefined;
  for (const entry of catalog) {
    for (const alias of entry.aliases) {
      const distance = levenshtein(normalised, alias);
      if (!best || distance < best.distance) {
        best = { target: entry.target, alias, distance };
      }
    }
  }
  if (best) {
    const longer = Math.max(normalised.length, best.alias.length);
    const similarity = longer === 0 ? 0 : 1 - best.distance / longer;
    // Accept fuzzy when within 1 edit on short codes or >=70% similar.
    if (best.distance <= 1 || similarity >= 0.7) {
      return { target: best.target, confidence: 0.7, matchType: "fuzzy", matchedAlias: best.alias };
    }
  }

  return { target: "", confidence: 0.3, matchType: "none" };
}

const ENTITY_FIELD_FOR_MAPPING: Record<MappingType, { entityTypes: string[]; field: string }> = {
  room_type: { entityTypes: ["room", "reservation"], field: "roomType" },
  rate_plan: { entityTypes: ["rate_plan"], field: "code" },
  channel: { entityTypes: ["channel", "reservation", "record"], field: "channel" },
  reservation_field: { entityTypes: ["reservation"], field: "" }
};

function collectSourceValues(entities: ExtractedEntity[], mappingType: MappingType): string[] {
  const spec = ENTITY_FIELD_FOR_MAPPING[mappingType];
  const values = new Set<string>();
  for (const entity of entities) {
    if (!spec.entityTypes.includes(entity.entityType)) continue;
    const raw = entity.fields[spec.field];
    if (typeof raw === "string" && raw.trim().length > 0) {
      values.add(raw.trim());
    }
  }
  return [...values];
}

function buildSuggestionsForType(entities: ExtractedEntity[], mappingType: Exclude<MappingType, "reservation_field">): MappingSuggestion[] {
  const catalog = CATALOGS[mappingType];
  const sourceValues = collectSourceValues(entities, mappingType);
  return sourceValues.map((sourceValue) => {
    const match = matchToCatalog(sourceValue, catalog);
    const rationale =
      match.matchType === "exact"
        ? `Exact alias match: "${normalise(sourceValue)}" -> "${match.target}".`
        : match.matchType === "fuzzy"
          ? `Fuzzy match to alias "${match.matchedAlias}" (review recommended).`
          : `No catalog match for "${sourceValue}"; needs human mapping (no value invented).`;
    return {
      id: deterministicId(`${mappingType}:${normalise(sourceValue)}`),
      mappingType,
      sourceValue,
      targetValue: match.target,
      confidence: match.confidence,
      status: "pending",
      rationale
    } satisfies MappingSuggestion;
  });
}

export function generateMappings(input: GenerateMappingsInput): MappingSuggestion[] {
  const target = input.target ?? "auto";
  const types: Array<Exclude<MappingType, "reservation_field">> =
    target === "auto" ? ["room_type", "rate_plan", "channel"] : [target];
  const suggestions: MappingSuggestion[] = [];
  for (const mappingType of types) {
    suggestions.push(...buildSuggestionsForType(input.entities, mappingType));
  }
  return suggestions;
}

export function summariseMappings(suggestions: MappingSuggestion[]) {
  const byType: Record<string, number> = {};
  let lowConfidence = 0;
  let confidenceSum = 0;
  for (const suggestion of suggestions) {
    byType[suggestion.mappingType] = (byType[suggestion.mappingType] ?? 0) + 1;
    confidenceSum += suggestion.confidence;
    if (suggestion.confidence < 0.7) lowConfidence += 1;
  }
  const total = suggestions.length;
  return {
    total,
    byType,
    lowConfidence,
    avgConfidence: total === 0 ? 0 : Math.round((confidenceSum / total) * 100) / 100
  };
}

function deterministicId(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `map_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export const MAPPING_CATALOGS = { ROOM_TYPE_CATALOG, RATE_CODE_CATALOG, CHANNEL_CATALOG };
