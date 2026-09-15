// CSV writer shared by the statements (download format csv) and the gestoría
// exports: `;` separator, CRLF, UTF-8 with BOM, decimal comma for amounts
// (the format Spanish spreadsheets and accounting packages open without a
// wizard). Fields containing `;`, `"`, CR or LF are quoted.

export const CSV_BOM = "﻿";
export const CSV_SEPARATOR = ";";

export type CsvCell = string | number | null | undefined;

function escapeCsvField(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : value;
  if (/[";\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

export function csvLine(cells: CsvCell[]): string {
  return cells.map(escapeCsvField).join(CSV_SEPARATOR);
}

/** Full document: BOM + header + rows, CRLF terminated. */
export function csvDocument(header: string[], rows: CsvCell[][]): string {
  const lines = [csvLine(header), ...rows.map(csvLine)];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** Several titled blocks in one CSV (statements with more than one table), separated by a blank line. */
export function csvBlocks(blocks: Array<{ title: string; header: string[]; rows: CsvCell[][] }>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(csvLine([block.title]));
    parts.push(csvLine(block.header));
    for (const row of block.rows) parts.push(csvLine(row));
    parts.push("");
  }
  return `${CSV_BOM}${parts.join("\r\n")}\r\n`;
}
