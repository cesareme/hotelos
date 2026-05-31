// Tiny dependency-free CSV/TSV parser. Handles quoted fields ("a,b"),
// escaped quotes ("" -> "), CRLF/LF line endings and a configurable delimiter.
// No external CSV library is used (Sprint 52 forbids adding npm packages).

export type ParsedTable = {
  delimiter: string;
  header: string[];
  rows: string[][];
};

const SUPPORTED_DELIMITERS = [",", "\t", ";", "|"] as const;

/**
 * Detect the most likely delimiter by counting occurrences (outside quotes)
 * on the first non-empty line and picking the one with the highest count.
 */
export function detectDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  let best = ",";
  let bestCount = -1;
  for (const delimiter of SUPPORTED_DELIMITERS) {
    const count = countUnquoted(firstLine, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function countUnquoted(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1; // escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

/** Split a single record into fields, honouring quotes. */
function splitRecord(record: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < record.length; i += 1) {
    const char = record[i];
    if (char === '"') {
      if (inQuotes && record[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

export function parseDelimited(content: string, delimiter?: string): ParsedTable {
  const resolvedDelimiter = delimiter ?? detectDelimiter(content);
  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { delimiter: resolvedDelimiter, header: [], rows: [] };
  }
  const header = splitRecord(lines[0]!, resolvedDelimiter);
  const rows = lines.slice(1).map((line) => splitRecord(line, resolvedDelimiter));
  return { delimiter: resolvedDelimiter, header, rows };
}
