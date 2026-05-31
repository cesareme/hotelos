/**
 * Lightweight client-side CSV export utility.
 *
 * Renders an in-memory CSV from an array of rows, then triggers a browser
 * download via a temporary <a download> element. No server round-trip and no
 * third-party dependency — keep this self-contained.
 *
 * Escaping follows RFC 4180: fields containing comma, double-quote or newline
 * are wrapped in double quotes and any embedded quote is doubled.
 */

export interface CsvColumn<T> {
  /** Object key in the row to read. */
  key: keyof T & string;
  /** Header label shown on the first CSV line. */
  label: string;
  /**
   * Optional formatter for the raw value (e.g. dates, numbers, enums).
   * Receives the value at `row[key]` plus the full row in case the formatter
   * needs sibling fields. The returned value is coerced to string.
   */
  format?: (value: T[CsvColumn<T>["key"]], row: T) => unknown;
}

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a CSV string and trigger a download. Returns silently if there are no
 * rows — callers typically guard with a toast for the empty case.
 *
 * @param rows     The records to export. Cannot be inferred from an empty
 *                 array, so pass `columns` when the list may be empty and you
 *                 still want headers.
 * @param filename Suggested filename. `.csv` is appended if missing.
 * @param columns  Optional explicit column set. When omitted, the keys of the
 *                 first row are used (label = key, no formatter).
 */
export function exportToCsv<T extends object>(
  rows: readonly T[],
  filename: string,
  columns?: ReadonlyArray<CsvColumn<T>>
): void {
  if (rows.length === 0 && !columns) return;

  const cols: ReadonlyArray<CsvColumn<T>> =
    columns ??
    (Object.keys(rows[0] as object) as Array<keyof T & string>).map((key) => ({
      key,
      label: key
    }));

  const header = cols.map((c) => escapeField(c.label)).join(",");
  const lines = rows.map((row) =>
    cols
      .map((c) => {
        const raw = row[c.key];
        const value = c.format ? c.format(raw, row) : raw;
        return escapeField(value);
      })
      .join(",")
  );

  // Prepend BOM so Excel opens UTF-8 files correctly on Windows locales.
  const csv = "﻿" + [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  // Some browsers require the anchor to be in the DOM for the synthetic click.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
