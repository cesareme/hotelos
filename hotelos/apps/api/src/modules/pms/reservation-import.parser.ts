// Importación masiva de reservas (Tanda 7 · L1) — parser de fichero, PURO.
//
// Convierte los bytes (o el texto) de un CSV o de un .xlsx en una `ParsedTable`
// común —cabecera + filas de datos con nº de fila, línea física y tipo de celda—
// sin tocar la base de datos ni la red:
//   · `decodeBytes` — BOM UTF-8 eliminado; `TextDecoder("utf-8", { fatal })` y,
//     si el fichero no es UTF-8 válido, Windows-1252 (0x80 = «€»);
//   · `detectDelimiter` — recuento fuera de comillas de «;», tabulador, «,» y
//     «|» sobre las 5 primeras líneas no vacías; desempate «;» > tab > «,» > «|»
//     (el `parseDelimited` de @hotelos/ai-tools desempata a favor de «,» y rompe
//     los campos entrecomillados con saltos de línea: no se reutiliza);
//   · `parseCsvTable` — autómata RFC 4180 (`""` → `"`, saltos de línea dentro de
//     comillas conservados, CR / LF / CRLF) con la línea física de cada registro;
//   · `parseXlsxTable` — envuelve `lib/xlsx-lite.ts` (primera hoja visible o la
//     pedida); `XlsxLiteError` → RESERVATION_IMPORT_UNREADABLE;
//   · `parseReservationImportFile` — entrada de las rutas y del CLI: formato por
//     `format` > extensión de `fileName` > firma ZIP («PK\x03\x04», `UEsDB` en
//     base64) > csv; límites de `@hotelos/shared` (5 MiB, 5.000 filas, 200
//     columnas, 2.000 caracteres por celda) como `ReservationImportParseError`.
//
// GDPR: los avisos citan fila, línea y columna; nunca el contenido de una celda.

import {
  RESERVATION_IMPORT_MAX_BYTES,
  RESERVATION_IMPORT_MAX_CELL_CHARS,
  RESERVATION_IMPORT_MAX_COLUMNS,
  RESERVATION_IMPORT_MAX_ROWS,
  type ReservationImportEncoding,
  type ReservationImportErrorCode,
  type ReservationImportFormat
} from "@hotelos/shared";
import { XlsxLiteError, readXlsxTable, type CellKind } from "../../lib/xlsx-lite.js";

export type { CellKind } from "../../lib/xlsx-lite.js";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Error de fichero (no de fila): el servicio lo devuelve como blocker en la preview o 400 en el commit. */
export class ReservationImportParseError extends Error {
  readonly code: ReservationImportErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ReservationImportErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReservationImportParseError";
    this.code = code;
    this.details = details;
  }
}

export type ParsedRow = {
  /** 1 = primera fila de datos tras la cabecera. */
  rowNumber: number;
  /** Línea física 1-based del fichero (CSV) o número de fila de la hoja (XLSX). */
  line: number;
  /** Celdas recortadas (espacios, NBSP, BOM residual), tantas como columnas tiene la cabecera. */
  cells: string[];
  kinds: CellKind[];
};

export type ParsedTable = {
  /** Cabecera tal cual (recortada); vacía → `columna_<n>`; repetida → «X (2)». */
  header: string[];
  rows: ParsedRow[];
  format: ReservationImportFormat;
  encoding?: ReservationImportEncoding;
  bom: boolean;
  delimiter?: string;
  sheetName?: string;
  /** Avisos de fichero en español (sin valores de celda). */
  warnings: string[];
  /** true si el lector XLSX cortó en `maxRows` (siempre acompañado de TOO_MANY_ROWS). */
  truncated: boolean;
};

export type ParseLimits = {
  maxRows?: number;
  maxColumns?: number;
  maxCellChars?: number;
};

export type ReservationImportFileInput = {
  format?: ReservationImportFormat;
  fileName?: string;
  /** Texto (CLI y tests). */
  content?: string;
  /** Bytes en base64 (siempre desde el navegador, CSV incluido). */
  contentBase64?: string;
  sheetName?: string;
};

export const CSV_DELIMITERS = [";", "\t", ",", "|"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

// ---------------------------------------------------------------------------
// Codificación y separador
// ---------------------------------------------------------------------------

/**
 * Bytes → texto. BOM `EF BB BF` eliminado (`bom = true`); UTF-8 estricto y, si
 * el fichero no es UTF-8 válido (Excel «CSV» en Windows), Windows-1252.
 */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: ReservationImportEncoding; bom: boolean } {
  let bom = false;
  let view = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    view = bytes.subarray(3);
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(view), encoding: "utf-8", bom };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(view), encoding: "windows-1252", bom };
  }
}

/** Recuento de un carácter fuera de comillas dobles. */
function countOutsideQuotes(line: string, char: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const current = line[i];
    if (current === '"') inQuotes = !inQuotes;
    else if (!inQuotes && current === char) count += 1;
  }
  return count;
}

/**
 * Separador más frecuente fuera de comillas en las 5 primeras líneas no vacías;
 * solo cuentan los que aparecen en la primera (la cabecera); empate → «;» > tab >
 * «,» > «|». Sin ninguno → «;».
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() !== "") lines.push(line);
    if (lines.length >= 5) break;
  }
  if (lines.length === 0) return ";";
  let best: CsvDelimiter = ";";
  let bestScore = 0;
  for (const candidate of CSV_DELIMITERS) {
    if (countOutsideQuotes(lines[0]!, candidate) === 0) continue;
    const score = lines.reduce((sum, line) => sum + countOutsideQuotes(line, candidate), 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Autómata RFC 4180
// ---------------------------------------------------------------------------

type CsvRecord = { line: number; fields: string[] };

const FIELD_START = 0;
const IN_FIELD = 1;
const IN_QUOTES = 2;
const QUOTE_IN_QUOTES = 3;

/** Registros del CSV con la línea física en la que empieza cada uno; nunca lanza. */
export function splitCsvRecords(text: string, delimiter: string): { records: CsvRecord[]; unterminatedQuote: boolean } {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let state = FIELD_START;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const length = text.length;

  const endRecord = (): void => {
    fields.push(field);
    field = "";
    records.push({ line: recordLine, fields });
    fields = [];
  };
  const newline = (char: string): void => {
    if (char === "\r" && text[i + 1] === "\n") i += 2;
    else i += 1;
    line += 1;
    recordLine = line;
  };

  while (i < length) {
    const char = text[i]!;
    switch (state) {
      case FIELD_START:
        if (char === '"') {
          state = IN_QUOTES;
          i += 1;
        } else if (char === delimiter) {
          fields.push(field);
          field = "";
          i += 1;
        } else if (char === "\r" || char === "\n") {
          endRecord();
          newline(char);
        } else {
          field += char;
          state = IN_FIELD;
          i += 1;
        }
        break;
      case IN_FIELD:
        if (char === delimiter) {
          fields.push(field);
          field = "";
          state = FIELD_START;
          i += 1;
        } else if (char === "\r" || char === "\n") {
          endRecord();
          newline(char);
          state = FIELD_START;
        } else {
          field += char;
          i += 1;
        }
        break;
      case IN_QUOTES:
        if (char === '"') {
          state = QUOTE_IN_QUOTES;
          i += 1;
        } else {
          // Salto de línea dentro de comillas: se conserva y cuenta como línea física.
          if (char === "\r" && text[i + 1] === "\n") {
            field += "\r\n";
            i += 2;
            line += 1;
          } else {
            field += char;
            if (char === "\n" || char === "\r") line += 1;
            i += 1;
          }
        }
        break;
      default: // QUOTE_IN_QUOTES
        if (char === '"') {
          field += '"';
          state = IN_QUOTES;
          i += 1;
        } else if (char === delimiter) {
          fields.push(field);
          field = "";
          state = FIELD_START;
          i += 1;
        } else if (char === "\r" || char === "\n") {
          endRecord();
          newline(char);
          state = FIELD_START;
        } else {
          // Texto tras la comilla de cierre: tolerante, se conserva.
          field += char;
          state = IN_FIELD;
          i += 1;
        }
        break;
    }
  }
  const unterminatedQuote = state === IN_QUOTES;
  if (state !== FIELD_START || fields.length > 0 || field !== "") endRecord();
  return { records, unterminatedQuote };
}

// ---------------------------------------------------------------------------
// Tabla común (cabecera + filas) con límites
// ---------------------------------------------------------------------------

type RawDataRow = { line: number; cells: string[]; kinds: CellKind[] };

function trimCell(value: string): string {
  return value.trim();
}

function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((cell) => cell === "");
}

/** Cabecera única: vacía → `columna_<n>`; repetida → «X (2)», «X (3)»… */
function uniqueHeader(header: string[], warnings: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((cell, index) => {
    let name = cell === "" ? `columna_${index + 1}` : cell;
    const times = seen.get(name) ?? 0;
    if (times > 0) {
      const base = name;
      name = `${base} (${times + 1})`;
      warnings.push(`La cabecera repite la columna ${index + 1}: se renombra con el sufijo «(${times + 1})».`);
      seen.set(base, times + 1);
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);
    return name;
  });
}

function buildTable(
  headerCells: string[],
  dataRows: RawDataRow[],
  meta: Omit<ParsedTable, "header" | "rows" | "warnings"> & { warnings: string[] },
  limits: ParseLimits
): ParsedTable {
  const maxRows = limits.maxRows ?? RESERVATION_IMPORT_MAX_ROWS;
  const maxColumns = limits.maxColumns ?? RESERVATION_IMPORT_MAX_COLUMNS;
  const maxCellChars = limits.maxCellChars ?? RESERVATION_IMPORT_MAX_CELL_CHARS;
  const warnings = meta.warnings;

  // Columnas = las de la cabecera; las finales con cabecera vacía y sin datos en
  // ninguna fila se descartan (Excel exporta «;;;» de relleno). Una fila nunca
  // amplía la cabecera: sus celdas sobrantes se ignoran con aviso.
  let columnCount = headerCells.length;
  while (columnCount > 0 && headerCells[columnCount - 1] === "" && dataRows.every((row) => (row.cells[columnCount - 1] ?? "") === "")) {
    columnCount -= 1;
  }
  if (columnCount > maxColumns) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_UNREADABLE", `El fichero tiene ${columnCount} columnas y el máximo admitido es ${maxColumns}.`, {
      reason: "too_many_columns",
      columns: columnCount,
      max: maxColumns
    });
  }
  if (columnCount === 0 || dataRows.length === 0) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_EMPTY", "El fichero no tiene filas de datos tras la cabecera.");
  }
  if (meta.truncated || dataRows.length > maxRows) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_TOO_MANY_ROWS", `El fichero tiene más de ${maxRows} filas de datos.`, {
      rows: dataRows.length,
      max: maxRows,
      truncated: meta.truncated
    });
  }

  const header = uniqueHeader(headerCells.slice(0, columnCount).map(trimCell), warnings);
  let longRows = 0;
  let truncatedCells = 0;
  const rows: ParsedRow[] = dataRows.map((row, index) => {
    const cells: string[] = new Array<string>(columnCount);
    const kinds: CellKind[] = new Array<CellKind>(columnCount);
    for (let col = 0; col < columnCount; col += 1) {
      let value = row.cells[col] ?? "";
      if (value.length > maxCellChars) {
        value = value.slice(0, maxCellChars);
        truncatedCells += 1;
        if (truncatedCells <= 20) {
          warnings.push(`Fila ${index + 1} (línea ${row.line}), columna «${header[col]}»: celda recortada a ${maxCellChars} caracteres.`);
        }
      }
      cells[col] = value;
      kinds[col] = value === "" ? "empty" : (row.kinds[col] ?? "string");
    }
    if (row.cells.length > columnCount && row.cells.slice(columnCount).some((cell) => cell !== "")) {
      longRows += 1;
      if (longRows <= 20) {
        warnings.push(`Fila ${index + 1} (línea ${row.line}): tiene ${row.cells.length - columnCount} columnas más que la cabecera; se ignoran.`);
      }
    }
    return { rowNumber: index + 1, line: row.line, cells, kinds };
  });
  if (truncatedCells > 20) warnings.push(`… y ${truncatedCells - 20} celdas recortadas más.`);
  if (longRows > 20) warnings.push(`… y ${longRows - 20} filas largas más.`);

  return { ...meta, header, rows, warnings };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * CSV → tabla. Acepta bytes (codificación detectada) o texto ya decodificado
 * (BOM U+FEFF inicial eliminado; U+FFFD → aviso «codificación no reconocida»).
 * La cabecera es el primer registro no vacío; las líneas vacías intermedias no
 * cuentan como fila pero sí como línea física.
 */
export function parseCsvTable(input: Uint8Array | string, limits: ParseLimits = {}): ParsedTable {
  const warnings: string[] = [];
  let text: string;
  let encoding: ReservationImportEncoding;
  let bom: boolean;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > RESERVATION_IMPORT_MAX_BYTES) {
      throw new ReservationImportParseError("RESERVATION_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (5 MB).", {
        bytes: Buffer.byteLength(input, "utf8"),
        max: RESERVATION_IMPORT_MAX_BYTES
      });
    }
    bom = input.startsWith("\uFEFF");
    text = bom ? input.slice(1) : input;
    encoding = "utf-8";
    if (text.includes("\uFFFD")) warnings.push("Codificación no reconocida: algunos caracteres del fichero no se han podido leer.");
  } else {
    if (input.length > RESERVATION_IMPORT_MAX_BYTES) {
      throw new ReservationImportParseError("RESERVATION_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (5 MB).", {
        bytes: input.length,
        max: RESERVATION_IMPORT_MAX_BYTES
      });
    }
    const decoded = decodeBytes(input);
    text = decoded.text;
    encoding = decoded.encoding;
    bom = decoded.bom;
    if (encoding === "windows-1252") warnings.push("El fichero no es UTF-8: se ha leído como Windows-1252 (latin1).");
  }
  if (text.trim() === "") {
    throw new ReservationImportParseError("RESERVATION_IMPORT_EMPTY", "El fichero está vacío.");
  }

  const delimiter = detectDelimiter(text);
  const { records, unterminatedQuote } = splitCsvRecords(text, delimiter);
  if (unterminatedQuote) warnings.push("Comillas sin cerrar al final del fichero: el último campo se ha tomado tal cual.");

  let headerCells: string[] | null = null;
  const dataRows: RawDataRow[] = [];
  for (const record of records) {
    const cells = record.fields.map(trimCell);
    if (isBlankRow(cells)) continue;
    if (!headerCells) {
      headerCells = cells;
      continue;
    }
    dataRows.push({ line: record.line, cells, kinds: cells.map((cell) => (cell === "" ? "empty" : "string")) });
  }
  if (!headerCells) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_EMPTY", "El fichero está vacío.");
  }
  return buildTable(headerCells, dataRows, { format: "csv", encoding, bom, delimiter, warnings, truncated: false }, limits);
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** .xlsx → tabla (hoja pedida o primera visible); `XlsxLiteError` → RESERVATION_IMPORT_UNREADABLE. */
export function parseXlsxTable(bytes: Uint8Array, options: { sheetName?: string } & ParseLimits = {}): ParsedTable {
  if (bytes.length > RESERVATION_IMPORT_MAX_BYTES) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (5 MB).", {
      bytes: bytes.length,
      max: RESERVATION_IMPORT_MAX_BYTES
    });
  }
  const maxRows = options.maxRows ?? RESERVATION_IMPORT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? RESERVATION_IMPORT_MAX_COLUMNS;
  const maxCellChars = options.maxCellChars ?? RESERVATION_IMPORT_MAX_CELL_CHARS;
  let table;
  try {
    table = readXlsxTable(bytes, { sheetName: options.sheetName, maxRows: maxRows + 1, maxCols: maxColumns + 1, maxCellChars });
  } catch (error) {
    if (error instanceof XlsxLiteError) {
      throw new ReservationImportParseError("RESERVATION_IMPORT_UNREADABLE", error.message, { reason: error.code, ...(error.details ?? {}) });
    }
    throw error;
  }
  const warnings = [...table.warnings];
  const [headerRow, ...bodyRows] = table.rows;
  if (!headerRow) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_EMPTY", "La hoja no tiene filas con datos.", { sheetName: table.sheetName });
  }
  const headerCells = headerRow.cells.map((cell) => trimCell(cell.raw));
  const dataRows: RawDataRow[] = bodyRows.map((row) => ({
    line: row.row,
    cells: row.cells.map((cell) => trimCell(cell.raw)),
    kinds: row.cells.map((cell) => cell.kind)
  }));
  return buildTable(
    headerCells,
    dataRows,
    { format: "xlsx", bom: false, sheetName: table.sheetName, warnings, truncated: table.truncated },
    { maxRows, maxColumns, maxCellChars }
  );
}

// ---------------------------------------------------------------------------
// Entrada única: formato + límites
// ---------------------------------------------------------------------------

const ZIP_SIGNATURE_BASE64 = "UEsDB";

function hasZipSignature(bytes: Uint8Array | undefined): boolean {
  return !!bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Formato por `format` > extensión de `fileName` > firma ZIP > csv. */
export function detectReservationImportFormat(input: {
  format?: ReservationImportFormat;
  fileName?: string;
  contentBase64?: string;
  content?: string;
  bytes?: Uint8Array;
}): ReservationImportFormat {
  if (input.format) return input.format;
  const name = (input.fileName ?? "").trim().toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(name)) return "xlsx";
  if (/\.(csv|txt|tsv)$/.test(name)) return "csv";
  if (hasZipSignature(input.bytes)) return "xlsx";
  if (input.contentBase64 && input.contentBase64.replace(/^\s+/, "").startsWith(ZIP_SIGNATURE_BASE64)) return "xlsx";
  // Texto: solo la firma completa PK\x03\x04 (una cabecera CSV que empiece por PK no es un ZIP).
  if (input.content && input.content.startsWith("PK\u0003\u0004")) return "xlsx";
  return "csv";
}

/**
 * Punto de entrada de las rutas y del CLI: decodifica `contentBase64` (bytes) o
 * usa `content` (texto), decide el formato, aplica los límites y devuelve la tabla.
 * Errores de fichero → `ReservationImportParseError` con `code` de
 * RESERVATION_IMPORT_ERROR_CODES.
 */
export function parseReservationImportFile(input: ReservationImportFileInput, limits: ParseLimits = {}): ParsedTable {
  const hasBase64 = typeof input.contentBase64 === "string" && input.contentBase64.length > 0;
  const hasContent = typeof input.content === "string" && input.content.length > 0;
  if (!hasBase64 && !hasContent) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_EMPTY", "No se ha recibido ningún fichero.");
  }
  const bytes = hasBase64 ? Buffer.from(input.contentBase64!, "base64") : undefined;
  if (bytes && bytes.length > RESERVATION_IMPORT_MAX_BYTES) {
    throw new ReservationImportParseError("RESERVATION_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (5 MB).", {
      bytes: bytes.length,
      max: RESERVATION_IMPORT_MAX_BYTES
    });
  }
  const format = detectReservationImportFormat({ format: input.format, fileName: input.fileName, contentBase64: input.contentBase64, content: input.content, bytes });
  if (format === "xlsx") {
    if (!bytes) {
      throw new ReservationImportParseError("RESERVATION_IMPORT_UNREADABLE", "Un libro .xlsx debe enviarse como contentBase64.", { reason: "xlsx_as_text" });
    }
    return parseXlsxTable(bytes, { sheetName: input.sheetName, ...limits });
  }
  return parseCsvTable(bytes ?? input.content!, limits);
}
