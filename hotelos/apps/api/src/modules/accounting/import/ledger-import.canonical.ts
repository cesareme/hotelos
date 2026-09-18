// Importación contable desde Sage 200 (Tanda 7c · L1) — formato canónico, PURO.
//
// Base común de los parsers (`sage200.parser.ts`), del mapa de cuentas
// (`ledger-import.mapping.ts`) y de la regla contable (`ledger-import.posting.ts`):
//   · tipos canónicos por tipo de lote (`CanonicalJournalRow`, `CanonicalBalanceRow`,
//     `CanonicalPlanRow`, `CanonicalThirdPartyRow`, `CanonicalVatRow`), con importes
//     como MoneyString (dos decimales, punto) y fechas ISO;
//   · `LedgerImportParseError(code, message, details)`: error tipado de fichero con
//     `code` de LEDGER_IMPORT_ERROR_CODES (LEDGER_IMPORT_INVALID lleva
//     `{ errors: [{ line, message }] }`);
//   · `readLedgerTable` — envuelve `parseCsvTable` / `parseXlsxTable` del importador
//     de reservas con los límites del lote (LEDGER_IMPORT_MAX_ROWS filas, 80 columnas,
//     2.000 caracteres por celda) y traduce sus errores a los códigos del lote;
//   · motor de columnas POR CABECERA (`matchColumns`): cada campo canónico casa con
//     sus sinónimos plegados (`foldHeader`) comparando la forma compacta (sin «_»),
//     así «Fecha asiento», «FechaAsiento» y «fecha_asiento» son la misma columna;
//     cabecera desconocida → aviso, obligatoria ausente → LEDGER_IMPORT_INVALID;
//   · parsers de tabla por tipo (`parseJournalTable`, `parseBalancesTable`,
//     `parsePlanTable`, `parseThirdPartiesTable`, `parseVatTable`) que reciben la
//     tabla de sinónimos del dialecto (canónico o Sage) y devuelven filas canónicas,
//     avisos y cabeceras desconocidas;
//   · `parseCanonicalCsv` / `parseCanonicalJson` (`{ system, company, kind, rows }`);
//   · `normalizeRows(kind, rows)` (importes a 2 decimales, textos recortados, filas
//     ordenadas por (ejercicio, asiento, orden)) y `contentHashOf(kind, rows)` =
//     sha256 del JSON canónico de las filas normalizadas ANTES del mapa de cuentas /
//     analítica (aclaración al diseño §4.2/§4.3: el hash no cambia al editar el mapa
//     y el mismo Excel y CSV dan el mismo hash; `line` y `orden` no entran);
//   · `buildCanonicalTemplate(kind)` → CSV `;` con BOM y una fila de ejemplo;
//   · `groupJournalRows(rows)` → asientos Sage `{ key: { companyCode, fiscalYear,
//     period, entryNumber, channel }, lines[] }`.
//
// Sin Prisma, sin red, sin disco: entrada texto / bytes, salida estructuras puras.
// Los mensajes de error citan línea y columna, nunca el contenido de una celda con
// datos personales (NIF / nombre).

import { createHash } from "node:crypto";
import {
  LEDGER_IMPORT_KINDS,
  LEDGER_IMPORT_MAX_BYTES,
  LEDGER_IMPORT_MAX_ROWS,
  type IsoDate,
  type LedgerImportErrorCode,
  type LedgerImportFormat,
  type LedgerImportKind,
  type MoneyString
} from "@hotelos/shared";
import { XlsxLiteError } from "../../../lib/xlsx-lite.js";
import { foldHeader } from "../../pms/reservation-import.mapping.js";
import { parseImportDate } from "../../pms/reservation-import.normalize.js";
import { ReservationImportParseError, parseCsvTable, parseXlsxTable, type ParsedRow, type ParsedTable } from "../../pms/reservation-import.parser.js";
import { money, type Decimal } from "../accounting.service.js";

// ---------------------------------------------------------------------------
// Error tipado de fichero
// ---------------------------------------------------------------------------

export type LedgerImportLineError = { line: number; message: string };

/** Error de fichero (no de fila): `code` de LEDGER_IMPORT_ERROR_CODES y `details` para la respuesta HTTP / el CLI. */
export class LedgerImportParseError extends Error {
  readonly code: LedgerImportErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: LedgerImportErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LedgerImportParseError";
    this.code = code;
    this.details = details;
  }
}

/** LEDGER_IMPORT_INVALID con la lista de errores de línea (recortada a 100 en `details`, el total en `errorCount`). */
export function invalidFileError(errors: readonly LedgerImportLineError[], summary?: string): LedgerImportParseError {
  const shown = errors.slice(0, 100);
  const message = summary ?? (errors.length === 1 ? `El fichero tiene un error: línea ${errors[0]!.line}, ${errors[0]!.message}` : `El fichero tiene ${errors.length} errores: revisa las líneas indicadas.`);
  return new LedgerImportParseError("LEDGER_IMPORT_INVALID", message, { errors: shown, errorCount: errors.length });
}

// ---------------------------------------------------------------------------
// Tipos canónicos
// ---------------------------------------------------------------------------

/**
 * Periodo Sage normalizado de un apunte de diario: `"0"` (Apertura) · `"1"`..`"12"` (mes) ·
 * `"ajustes"` (periodo «Regul. y Ajustes»: asientos normales fechados a fin de ejercicio) ·
 * `"regularizacion"` («Cierre ejercicio» de Sage: 6/7 contra 129 → entryKind regularization) ·
 * `"cierre"` («Cierre Contabilidad» de Sage: grupos 1-5 → entryKind closing). [S] los códigos
 * numéricos 13 / 14 / 15 de Sage para esos tres periodos son un supuesto documentado.
 */
export const SAGE_PERIOD_CODES = Object.freeze({
  opening: "0",
  adjustments: "ajustes",
  regularization: "regularizacion",
  closing: "cierre"
} as const);

export type CanonicalJournalRow = {
  /** Línea física del CSV o fila de la hoja (para los mensajes). */
  line: number;
  /** Posición 1-based en el fichero: conserva el orden de los apuntes dentro del asiento. */
  orden: number;
  empresa: string;
  ejercicio: string;
  asiento: string;
  fecha: IsoDate;
  periodo: string;
  cuenta: string;
  debe: MoneyString;
  haber: MoneyString;
  concepto: string | null;
  documento: string | null;
  canal: string | null;
  delegacion: string | null;
  departamento: string | null;
  seccion: string | null;
  proyecto: string | null;
  serie: string | null;
  factura: string | null;
  su_factura_no: string | null;
  fecha_factura: IsoDate | null;
  nif: string | null;
  nombre: string | null;
  base_iva: MoneyString | null;
  /** Tipo impositivo en porcentaje como texto ("21", "10", "0"). */
  tipo_iva: string | null;
  cuota_iva: MoneyString | null;
  /** E emitida · R recibida (convención propia, no de Sage) u otro literal del fichero. */
  tipo_factura: string | null;
  diario: string | null;
  contrapartida: string | null;
};

/** Código de periodo de un saldo: "YYYY-MM" · "YYYY-Qn" · "YYYY" · "apertura". */
export type CanonicalBalanceRow = {
  line: number;
  empresa: string;
  ejercicio: string;
  periodo: string;
  cuenta: string;
  titulo: string | null;
  delegacion: string | null;
  apertura_debe: MoneyString;
  apertura_haber: MoneyString;
  debe: MoneyString;
  haber: MoneyString;
  saldo_deudor: MoneyString;
  saldo_acreedor: MoneyString;
};

export type CanonicalPlanRow = {
  line: number;
  cuenta: string;
  titulo: string | null;
  nif: string | null;
  pais: string | null;
  longitud: number | null;
};

export type CanonicalThirdPartyRow = {
  line: number;
  codigo: string;
  rol: "customer" | "supplier";
  cuenta: string | null;
  nif: string | null;
  pais: string | null;
  nombre: string | null;
};

export type CanonicalVatRow = {
  line: number;
  libro: "emitidas" | "recibidas";
  empresa: string;
  ejercicio: string;
  fecha: IsoDate;
  fecha_operacion: IsoDate | null;
  serie: string | null;
  numero: string;
  nif: string | null;
  nombre: string | null;
  pais: string | null;
  base: MoneyString;
  tipo_iva: string;
  cuota: MoneyString;
  total: MoneyString;
  tipo_recargo: string | null;
  cuota_recargo: MoneyString | null;
  tipo_retencion: string | null;
  retencion: MoneyString | null;
  tipo_factura: string | null;
  rectificativa: boolean;
  /** recibidas: cuota deducible (null = toda). */
  cuota_deducible: MoneyString | null;
};

export type CanonicalRowOf<K extends LedgerImportKind> = K extends "journal" | "fiscal_years"
  ? CanonicalJournalRow
  : K extends "balances"
    ? CanonicalBalanceRow
    : K extends "plan"
      ? CanonicalPlanRow
      : K extends "third_parties"
        ? CanonicalThirdPartyRow
        : CanonicalVatRow;

export type CanonicalRow = CanonicalJournalRow | CanonicalBalanceRow | CanonicalPlanRow | CanonicalThirdPartyRow | CanonicalVatRow;

/** Columnas del CSV canónico por tipo (diseño §4.3), en el orden de la plantilla. */
export const CANONICAL_COLUMNS: Readonly<Record<LedgerImportKind, readonly string[]>> = Object.freeze({
  journal: ["empresa", "ejercicio", "asiento", "fecha", "periodo", "cuenta", "debe", "haber", "concepto", "documento", "canal", "delegacion", "departamento", "seccion", "proyecto", "serie", "factura", "fecha_factura", "nif", "nombre", "base_iva", "tipo_iva", "cuota_iva", "tipo_factura"],
  fiscal_years: ["empresa", "ejercicio", "asiento", "fecha", "periodo", "cuenta", "debe", "haber", "concepto", "documento", "canal", "delegacion", "departamento", "seccion", "proyecto", "serie", "factura", "fecha_factura", "nif", "nombre", "base_iva", "tipo_iva", "cuota_iva", "tipo_factura"],
  balances: ["empresa", "ejercicio", "periodo", "cuenta", "titulo", "delegacion", "apertura_debe", "apertura_haber", "debe", "haber", "saldo_deudor", "saldo_acreedor"],
  plan: ["cuenta", "titulo", "nif", "pais", "longitud"],
  third_parties: ["codigo", "rol", "cuenta", "nif", "pais", "nombre"],
  vat_books: ["libro", "empresa", "ejercicio", "fecha", "fecha_operacion", "serie", "numero", "nif", "nombre", "pais", "base", "tipo_iva", "cuota", "total", "tipo_recargo", "cuota_recargo", "tipo_retencion", "retencion", "tipo_factura", "rectificativa"]
});

/** Columnas canónicas OBLIGATORIAS por tipo (la detección `canonical_csv` exige la cabecera completa de CANONICAL_COLUMNS). */
export const CANONICAL_REQUIRED_COLUMNS: Readonly<Record<LedgerImportKind, readonly string[]>> = Object.freeze({
  journal: ["asiento", "fecha", "cuenta"],
  fiscal_years: ["asiento", "fecha", "cuenta"],
  balances: ["cuenta"],
  plan: ["cuenta"],
  third_parties: ["codigo"],
  vat_books: ["fecha", "numero", "base", "tipo_iva", "cuota"]
});

/** Fila de ejemplo de la plantilla canónica (empresa ficticia, NIF sintético). */
const TEMPLATE_EXAMPLE_ROWS: Readonly<Record<LedgerImportKind, readonly string[][]>> = Object.freeze({
  journal: [
    ["1", "2026", "1501", "2026-09-03", "9", "6280001", "250,00", "", "Electricidad septiembre", "F-778", "", "RA", "POM", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026", "1501", "2026-09-03", "9", "4720021", "52,50", "", "IVA soportado 21 %", "F-778", "", "RA", "", "", "", "", "", "", "", "", "250,00", "21", "52,50", "R"],
    ["1", "2026", "1501", "2026-09-03", "9", "4000000042", "", "302,50", "Suministros Eléctricos del Noroeste SL", "F-778", "", "RA", "", "", "", "", "", "2026-09-03", "A12345674", "SUMINISTROS ELECTRICOS DEL NOROESTE SL", "", "", "", ""]
  ],
  fiscal_years: [
    ["1", "2026", "1", "2026-01-01", "0", "5720000", "12000,00", "", "Apertura 2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "2026", "1", "2026-01-01", "0", "1000000", "", "12000,00", "Apertura 2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]
  ],
  balances: [["1", "2025", "2025-12", "6280001", "Electricidad", "RA", "0,00", "0,00", "1250,00", "0,00", "1250,00", "0,00"]],
  plan: [["6280001", "Electricidad", "", "", "7"]],
  third_parties: [["42", "supplier", "4000000042", "A12345674", "ES", "Suministros Eléctricos del Noroeste SL"]],
  vat_books: [["emitidas", "1", "2026", "2026-09-03", "", "FAC-2026", "000123", "A23456783", "Viajes Cantábrico SL", "ES", "1000,00", "10", "100,00", "1100,00", "", "", "", "", "F1", "no"]]
});

// ---------------------------------------------------------------------------
// Lectura de tabla (CSV / XLSX) con los límites del lote
// ---------------------------------------------------------------------------

/** Límites del lector de tabla del lote (columnas: 60 del CSV IME + margen; celdas: 2.000 caracteres). */
export const LEDGER_TABLE_LIMITS = Object.freeze({ maxRows: LEDGER_IMPORT_MAX_ROWS, maxColumns: 80, maxCellChars: 2000 });

export type LedgerTableInput = {
  /** Bytes del fichero (XLSX o CSV). */
  bytes?: Uint8Array;
  /** Texto ya decodificado (CSV / JSON canónicos, CLI y tests). */
  content?: string;
  fileName?: string;
  sheetName?: string;
  /** Fuerza el lector: xlsx o csv; por defecto extensión de `fileName` > firma ZIP > csv. */
  reader?: "xlsx" | "csv";
};

export function hasZipSignature(bytes: Uint8Array | undefined): boolean {
  return !!bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function translateTableError(error: unknown): never {
  if (error instanceof ReservationImportParseError) {
    switch (error.code) {
      case "RESERVATION_IMPORT_TOO_LARGE":
        throw new LedgerImportParseError("LEDGER_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido por el lector de tablas: usa el CLI o trocéalo por meses.", { ...(error.details ?? {}) });
      case "RESERVATION_IMPORT_TOO_MANY_ROWS":
        throw new LedgerImportParseError("LEDGER_IMPORT_TOO_MANY_ROWS", `El fichero tiene más de ${LEDGER_IMPORT_MAX_ROWS} filas de datos: trocéalo por meses.`, { ...(error.details ?? {}) });
      case "RESERVATION_IMPORT_EMPTY":
        throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El fichero no contiene filas de datos.", { ...(error.details ?? {}) });
      default:
        throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", error.message, { errors: [{ line: 0, message: error.message }], reason: error.details?.reason ?? error.code });
    }
  }
  if (error instanceof XlsxLiteError) {
    throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", error.message, { errors: [{ line: 0, message: error.message }], reason: error.code });
  }
  throw error;
}

/**
 * Bytes o texto → `ParsedTable` (cabecera + filas) con los límites del lote. XLSX por
 * extensión o firma ZIP, CSV en otro caso. Errores → LedgerImportParseError.
 */
export function readLedgerTable(input: LedgerTableInput): ParsedTable {
  const bytes = input.bytes;
  if (bytes && bytes.length > LEDGER_IMPORT_MAX_BYTES) {
    throw new LedgerImportParseError("LEDGER_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (20 MB): usa el CLI o trocéalo por meses.", { bytes: bytes.length, max: LEDGER_IMPORT_MAX_BYTES });
  }
  const name = (input.fileName ?? "").trim().toLowerCase();
  const reader: "xlsx" | "csv" = input.reader ?? (/\.(xlsx|xlsm)$/.test(name) || (!/\.(csv|txt|tsv)$/.test(name) && hasZipSignature(bytes)) ? "xlsx" : "csv");
  try {
    if (reader === "xlsx") {
      if (!bytes) throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", "Un libro .xlsx debe llegar como bytes (contentBase64), no como texto.", { errors: [{ line: 0, message: "libro xlsx enviado como texto" }] });
      return parseXlsxTable(bytes, { sheetName: input.sheetName, ...LEDGER_TABLE_LIMITS });
    }
    if (bytes) return parseCsvTable(bytes, LEDGER_TABLE_LIMITS);
    if (typeof input.content === "string" && input.content.length > 0) return parseCsvTable(input.content, LEDGER_TABLE_LIMITS);
    throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "No se ha recibido ningún fichero.");
  } catch (error) {
    return translateTableError(error);
  }
}

// ---------------------------------------------------------------------------
// Motor de columnas por cabecera
// ---------------------------------------------------------------------------

export type HeaderSynonyms = Readonly<Record<string, readonly string[]>>;

export type ColumnMatch = {
  /** campo canónico → índice de columna. */
  index: Map<string, number>;
  /** Cabeceras del fichero sin campo (tal cual, recortadas). */
  unknownHeaders: string[];
  warnings: string[];
};

/** Forma compacta de una cabecera plegada: sin «_» («fecha_asiento» ≡ «fechaasiento» ≡ «FechaAsiento»). */
export function compactHeader(value: string): string {
  return foldHeader(value).replace(/_/g, "");
}

/**
 * Casa cada columna del fichero con un campo canónico por igualdad de la forma compacta
 * de la cabecera con el nombre del campo o uno de sus sinónimos. Un campo en dos columnas:
 * la primera gana y la repetida se avisa; una columna sin campo → `unknownHeaders`.
 */
export function matchColumns(header: readonly string[], synonyms: HeaderSynonyms): ColumnMatch {
  const byCompact = new Map<string, string>();
  for (const [field, list] of Object.entries(synonyms)) {
    if (!byCompact.has(field.replace(/_/g, ""))) byCompact.set(field.replace(/_/g, ""), field);
    for (const synonym of list) {
      const compact = synonym.replace(/_/g, "").toLowerCase();
      if (!byCompact.has(compact)) byCompact.set(compact, field);
    }
  }
  const index = new Map<string, number>();
  const unknownHeaders: string[] = [];
  const warnings: string[] = [];
  header.forEach((cell, column) => {
    const compact = compactHeader(cell);
    const field = compact === "" ? undefined : byCompact.get(compact);
    if (!field) {
      if (!/^columna_\d+$/.test(cell)) unknownHeaders.push(cell);
      return;
    }
    if (index.has(field)) {
      warnings.push(`La columna ${column + 1} («${cell}») repite el campo «${field}» de la columna ${index.get(field)! + 1}: se ignora.`);
      return;
    }
    index.set(field, column);
  });
  return { index, unknownHeaders, warnings };
}

/** Tabla de sinónimos canónica: cada campo solo casa consigo mismo. */
export function canonicalSynonymsFor(kind: LedgerImportKind): HeaderSynonyms {
  const out: Record<string, readonly string[]> = {};
  for (const column of CANONICAL_COLUMNS[kind]) out[column] = [];
  if (kind === "journal" || kind === "fiscal_years") {
    out.su_factura_no = [];
    out.diario = [];
    out.contrapartida = [];
  }
  if (kind === "vat_books") out.cuota_deducible = [];
  return out;
}

// ---------------------------------------------------------------------------
// Normalizadores de celda
// ---------------------------------------------------------------------------

export type NumberStyle = "es" | "en" | "auto";

/** «1.234,56» / «1234,5» → es; «1,234.56» / «1234.5» → en; solo enteros o vacío → auto. */
export function detectNumberStyle(samples: Iterable<string>): NumberStyle {
  let es = 0;
  let en = 0;
  for (const raw of samples) {
    const text = raw.replace(/[\s€\u00A0]/g, "");
    if (/,\d{1,2}$/.test(text) || /\.\d{3},\d+$/.test(text)) es += 1;
    else if (/\.\d{1,2}$/.test(text) && !/^\d{1,3}\.\d{3}$/.test(text)) en += 1;
    else if (/,\d{3}\.\d+$/.test(text)) en += 1;
  }
  if (es > 0 && en === 0) return "es";
  if (en > 0 && es === 0) return "en";
  return "auto";
}

/**
 * Importe con signo → Decimal (2 decimales, HALF_UP) o null si no es numérico. Estilo `es`:
 * punto = miles, coma = decimal; `en`: coma = miles, punto = decimal; `auto`: la última coma o
 * punto es el decimal (regla de `parseAmount` de nómina), «1.234» aislado se toma como decimal.
 * Celdas numéricas del XLSX (`kind number`) siempre en `en`.
 */
export function parseSignedAmount(raw: string, style: NumberStyle = "auto"): Decimal | null {
  let text = raw.replace(/[\uFEFF\s€\u00A0]/g, "");
  if (text === "" || text === "-") return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith("-")) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  if (style === "es") {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (style === "en") {
    text = text.replace(/,/g, "");
  } else {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) text = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
    else if (lastComma >= 0) {
      if ((text.match(/,/g) ?? []).length > 1) return null;
      text = text.replace(",", ".");
    } else if (lastDot >= 0 && (text.match(/\./g) ?? []).length > 1) text = text.replace(/\./g, "");
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return null;
  let value: Decimal;
  try {
    value = money(text);
  } catch {
    return null;
  }
  return negative ? value.negated() : value;
}

/** Celda de fecha → ISO (dd/mm/yyyy, yyyy-mm-dd, yyyymmdd, serial Excel o celda de fecha del XLSX) o null. */
export function parseCellDate(raw: string, kind: ParsedRow["kinds"][number] = "string"): IsoDate | null {
  const parsed = parseImportDate(raw, kind);
  return parsed ? parsed.iso : null;
}

/** Texto recortado; vacío → null. */
export function cellText(raw: string | undefined): string | null {
  const text = (raw ?? "").replace(/\uFEFF/g, "").trim();
  return text === "" ? null : text;
}

/** Código de cuenta / asiento / periodo numérico exportado por Excel como «4300000.0» o «1.501E3» → entero como texto. */
export function cellCode(raw: string | undefined): string | null {
  const text = cellText(raw);
  if (text === null) return null;
  const numeric = /^(\d+)(?:[.,]0+)?$/.exec(text.replace(/\s/g, ""));
  return numeric ? numeric[1]! : text;
}

/** Tipo impositivo → "21" / "10" / "0" (acepta «21», «21,00», «21 %», «0.21»). */
export function parseRateCode(raw: string | undefined): string | null {
  const text = cellText(raw)?.replace(/%/g, "").trim();
  if (!text) return null;
  const value = parseSignedAmount(text, "auto");
  if (value === null || value.isNegative()) return null;
  const percent = value.lessThan(1) && !value.isZero() ? value.times(100) : value;
  return String(percent.toDecimalPlaces(0).toNumber());
}

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

/**
 * Periodo Sage de un apunte → código canónico: 0..12 numéricos; «Apertura» → "0";
 * «Regul. y Ajustes» → "ajustes"; «Cierre ejercicio» → "regularizacion"; «Cierre Contabilidad»
 * → "cierre"; 13 / 14 / 15 → esos tres en ese orden [S]. Otro valor → null.
 */
export function normalizeSagePeriod(raw: string | undefined): string | null {
  const text = cellCode(raw);
  if (text === null) return null;
  if (/^\d{1,2}$/.test(text)) {
    const n = Number(text);
    if (n >= 0 && n <= 12) return String(n);
    if (n === 13) return SAGE_PERIOD_CODES.adjustments;
    if (n === 14) return SAGE_PERIOD_CODES.regularization;
    if (n === 15) return SAGE_PERIOD_CODES.closing;
    // Formato real confirmado (Sage 200 2026.85, «Número periodo» del Diario General): 98 = regularización
    // («Cierre Ejer.»), 99 = cierre de contabilidad («Cierre Conta»).
    if (n === 98) return SAGE_PERIOD_CODES.regularization;
    if (n === 99) return SAGE_PERIOD_CODES.closing;
    return null;
  }
  const folded = foldHeader(text);
  if (folded === "" ) return null;
  if (folded.includes("apertura")) return SAGE_PERIOD_CODES.opening;
  if (folded.includes("regul") && folded.includes("ajust")) return SAGE_PERIOD_CODES.adjustments;
  if (folded === "ajustes") return SAGE_PERIOD_CODES.adjustments;
  // «Cierre Contabilidad» / «Cierre Conta» → cierre; «Cierre ejercicio» / «Cierre Ejer.» → regularización (columna «Período» real de Sage 200).
  if (folded.includes("cierre") && folded.includes("conta")) return SAGE_PERIOD_CODES.closing;
  if (folded.includes("cierre") && folded.includes("ejer")) return SAGE_PERIOD_CODES.regularization;
  if (folded.includes("regulariz")) return SAGE_PERIOD_CODES.regularization;
  if (folded === "cierre") return SAGE_PERIOD_CODES.closing;
  const month = MONTH_NAMES[folded];
  if (month) return String(month);
  return null;
}

const MONTH_NAMES: Readonly<Record<string, number>> = Object.freeze({
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12
});

/** true si el periodo es uno de los especiales (apertura / ajustes / regularización / cierre). */
export function isSpecialPeriod(period: string): boolean {
  return period === SAGE_PERIOD_CODES.opening || period === SAGE_PERIOD_CODES.adjustments || period === SAGE_PERIOD_CODES.regularization || period === SAGE_PERIOD_CODES.closing;
}

/**
 * Periodo de un saldo → "YYYY-MM" · "YYYY-Qn" · "YYYY" · "apertura": acepta «2025-09», «09/2025»,
 * «9» (+ ejercicio), «3T» / «T3» / «Q3» / «2025-Q3» (+ ejercicio), «2025» / «anual», «apertura».
 */
export function normalizeBalancePeriod(raw: string | undefined, fiscalYear: string | null): string | null {
  const text = cellText(raw);
  if (text === null) return null;
  const folded = foldHeader(text);
  if (folded.includes("apertura") || folded === "inicial") return "apertura";
  if (folded === "anual" || folded === "ejercicio" || folded === "total") return fiscalYear;
  let match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match) return Number(match[2]) >= 1 && Number(match[2]) <= 12 ? text : null;
  match = /^(\d{1,2})[/-](\d{4})$/.exec(text);
  if (match) return Number(match[1]) >= 1 && Number(match[1]) <= 12 ? `${match[2]}-${String(Number(match[1])).padStart(2, "0")}` : null;
  match = /^(\d{4})-?[qt](\d)$/i.exec(text);
  if (match) return Number(match[2]) >= 1 && Number(match[2]) <= 4 ? `${match[1]}-Q${match[2]}` : null;
  match = /^(?:[qt](\d)|(\d)[qt])$/i.exec(text);
  if (match) {
    const quarter = Number(match[1] ?? match[2]);
    return fiscalYear && quarter >= 1 && quarter <= 4 ? `${fiscalYear}-Q${quarter}` : null;
  }
  match = /^(\d{4})$/.exec(text);
  if (match) return text;
  match = /^(\d{1,2})$/.exec(text);
  if (match) {
    const n = Number(match[1]);
    if (n === 0) return "apertura";
    return fiscalYear && n >= 1 && n <= 12 ? `${fiscalYear}-${String(n).padStart(2, "0")}` : null;
  }
  const month = MONTH_NAMES[folded];
  if (month && fiscalYear) return `${fiscalYear}-${String(month).padStart(2, "0")}`;
  return null;
}

/** Último día del periodo de saldos ("YYYY-MM" → fin de mes, "YYYY-Qn" → fin de trimestre, "YYYY" → 31/12). */
export function balancePeriodEndDate(period: string): IsoDate | null {
  let match = /^(\d{4})-(\d{2})$/.exec(period);
  if (match) return lastDayOf(Number(match[1]), Number(match[2]));
  match = /^(\d{4})-Q(\d)$/.exec(period);
  if (match) return lastDayOf(Number(match[1]), Number(match[2]) * 3);
  match = /^(\d{4})$/.exec(period);
  if (match) return `${match[1]}-12-31`;
  return null;
}

function lastDayOf(year: number, month: number): IsoDate {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Parsers de tabla por tipo (dialecto = tabla de sinónimos)
// ---------------------------------------------------------------------------

export type TableParseResult<T> = {
  rows: T[];
  warnings: string[];
  unknownHeaders: string[];
  /** Estilo numérico detectado en las columnas de importe (informativo). */
  numberStyle?: NumberStyle;
};

export type JournalTableOptions = {
  synonyms: HeaderSynonyms;
  /** `empresa` cuando el fichero no trae la columna (por defecto "1", avisado). */
  companyCode?: string;
  /** Ejercicio esperado; si el fichero no trae columna se usa el año de la fecha. */
  fiscalYearCode?: string;
};

const MAX_ERRORS = 500;

function amountSamples(table: ParsedTable, columns: readonly (number | undefined)[]): string[] {
  const out: string[] = [];
  const limit = Math.min(table.rows.length, 400);
  for (let i = 0; i < limit; i += 1) {
    const row = table.rows[i]!;
    for (const column of columns) {
      if (column === undefined) continue;
      if (row.kinds[column] === "number") continue;
      const cell = row.cells[column] ?? "";
      if (cell !== "") out.push(cell);
    }
  }
  return out;
}

function cellAmount(row: ParsedRow, column: number | undefined, style: NumberStyle): Decimal | null | undefined {
  if (column === undefined) return undefined;
  const raw = row.cells[column] ?? "";
  if (raw.trim() === "") return null;
  return parseSignedAmount(raw, row.kinds[column] === "number" ? "en" : style);
}

function get(row: ParsedRow, column: number | undefined): string | undefined {
  return column === undefined ? undefined : row.cells[column];
}

function kindOf(row: ParsedRow, column: number | undefined): ParsedRow["kinds"][number] {
  return column === undefined ? "string" : (row.kinds[column] ?? "string");
}

function isDebitMarker(raw: string): boolean | null {
  const folded = foldHeader(raw);
  if (folded === "d" || folded === "debe" || folded === "cargo" || folded === "debit" || folded === "1") return true;
  if (folded === "h" || folded === "haber" || folded === "abono" || folded === "credit" || folded === "2" || folded === "c") return false;
  return null;
}

/**
 * Tabla → filas de diario canónicas. Debe/Haber, o Cargo/Abono (D/H, d/h, Cargo/Abono,
 * Debe/Haber) + Importe (negativo cambia de lado). Fechas dd/mm/yyyy, yyyy-mm-dd y seriales
 * Excel. Sin columna de periodo: mes de la fecha, y "0" si el asiento es de apertura (todas
 * sus líneas de grupos 1-5 fechadas el primer día del ejercicio) [S]. Fecha fuera del
 * ejercicio declarado (salvo periodos especiales) → error de fila. Errores de fila →
 * LEDGER_IMPORT_INVALID { errors }.
 */
export function parseJournalTable(table: ParsedTable, options: JournalTableOptions): TableParseResult<CanonicalJournalRow> {
  const match = matchColumns(table.header, options.synonyms);
  const warnings = [...table.warnings, ...match.warnings];
  const col = (field: string): number | undefined => match.index.get(field);
  const errors: LedgerImportLineError[] = [];
  const missing: string[] = [];
  for (const field of ["asiento", "fecha", "cuenta"]) if (col(field) === undefined) missing.push(field);
  const hasDebitCredit = col("debe") !== undefined || col("haber") !== undefined;
  const hasSideAmount = col("cargo_abono") !== undefined && col("importe") !== undefined;
  if (!hasDebitCredit && !hasSideAmount) missing.push("debe/haber (o cargo_abono + importe)");
  if (missing.length > 0) {
    throw invalidFileError(
      [{ line: 1, message: `faltan columnas obligatorias: ${missing.join(", ")}` }],
      `La cabecera no tiene las columnas obligatorias: ${missing.join(", ")}.`
    );
  }
  for (const header of match.unknownHeaders) warnings.push(`Columna «${header}» no reconocida: se ignora.`);
  let companyDefaulted = false;
  if (col("empresa") === undefined) companyDefaulted = true;
  if (col("periodo") === undefined) warnings.push("El fichero no trae columna de periodo: se toma el mes de la fecha del asiento (y 0 para la apertura).");
  if (col("ejercicio") === undefined) warnings.push(`El fichero no trae columna de ejercicio: se toma ${options.fiscalYearCode ? `el ejercicio ${options.fiscalYearCode}` : "el año de la fecha del asiento"}.`);

  const style = detectNumberStyle(amountSamples(table, [col("debe"), col("haber"), col("importe"), col("base_iva"), col("cuota_iva")]));
  const rows: CanonicalJournalRow[] = [];
  let negativeSwaps = 0;
  let extraVatBlocks = 0;

  table.rows.forEach((row, position) => {
    const fail = (message: string): void => {
      if (errors.length < MAX_ERRORS) errors.push({ line: row.line, message });
    };
    const cuenta = cellCode(get(row, col("cuenta")));
    const asiento = cellCode(get(row, col("asiento")));
    const fechaRaw = get(row, col("fecha")) ?? "";
    const fecha = parseCellDate(fechaRaw, kindOf(row, col("fecha")));
    if (!cuenta) fail("la cuenta está vacía");
    if (!asiento) fail("el número de asiento está vacío");
    if (!fecha) fail(`la fecha del asiento no es válida (columna ${(col("fecha") ?? 0) + 1})`);
    if (!cuenta || !asiento || !fecha) return;

    let debe: Decimal = money(0);
    let haber: Decimal = money(0);
    if (hasDebitCredit) {
      const d = cellAmount(row, col("debe"), style);
      const h = cellAmount(row, col("haber"), style);
      const dRaw = get(row, col("debe"))?.trim() ?? "";
      const hRaw = get(row, col("haber"))?.trim() ?? "";
      if ((dRaw !== "" && d === null) || (hRaw !== "" && h === null)) {
        fail("el importe no es numérico");
        return;
      }
      // Columna ausente (undefined) o celda vacía (null): importe 0 en ese lado.
      if (d) {
        if (d.isNegative()) {
          haber = haber.plus(d.abs());
          negativeSwaps += 1;
        } else debe = debe.plus(d);
      }
      if (h) {
        if (h.isNegative()) {
          debe = debe.plus(h.abs());
          negativeSwaps += 1;
        } else haber = haber.plus(h);
      }
      if (debe.isZero() && haber.isZero()) {
        if (!hasSideAmount) {
          fail("el apunte no tiene importe en Debe ni en Haber");
          return;
        }
        // Debe/Haber vacíos pero hay Cargo/Abono + Importe: se usa ese bloque.
        const side = applySideAmount(row, col("cargo_abono")!, col("importe")!, style, fail);
        if (!side) return;
        debe = side.debe;
        haber = side.haber;
        if (side.swapped) negativeSwaps += 1;
      }
    } else {
      const side = applySideAmount(row, col("cargo_abono")!, col("importe")!, style, fail);
      if (!side) return;
      debe = side.debe;
      haber = side.haber;
      if (side.swapped) negativeSwaps += 1;
    }
    if (!debe.isZero() && !haber.isZero()) {
      fail("el apunte tiene importe en Debe y en Haber a la vez");
      return;
    }

    let ejercicio = cellCode(get(row, col("ejercicio"))) ?? options.fiscalYearCode ?? fecha.slice(0, 4);
    if (!/^\d{4}$/.test(ejercicio)) {
      fail(`el ejercicio «${ejercicio}» no es un año de cuatro cifras`);
      return;
    }
    let periodo: string;
    if (col("periodo") !== undefined) {
      const raw = get(row, col("periodo"));
      const normalized = normalizeSagePeriod(raw);
      if (normalized === null) {
        if (cellText(raw) === null) periodo = String(Number(fecha.slice(5, 7)));
        else {
          fail(`el periodo no se reconoce (columna ${col("periodo")! + 1})`);
          return;
        }
      } else periodo = normalized;
    } else periodo = String(Number(fecha.slice(5, 7)));
    if (!isSpecialPeriod(periodo) && fecha.slice(0, 4) !== ejercicio) {
      fail(`la fecha ${fecha} no pertenece al ejercicio ${ejercicio}`);
      return;
    }
    if (isSpecialPeriod(periodo) && fecha.slice(0, 4) !== ejercicio) {
      // Apertura fechada el primer día o cierre el último: el año debe ser el del ejercicio también.
      fail(`la fecha ${fecha} del periodo «${periodo}» no pertenece al ejercicio ${ejercicio}`);
      return;
    }
    ejercicio = String(Number(ejercicio));

    const baseIva = cellAmount(row, col("base_iva"), style);
    const cuotaIva = cellAmount(row, col("cuota_iva"), style);
    if (baseIva === null && (get(row, col("base_iva"))?.trim() ?? "") !== "") fail("la base de IVA no es numérica");
    for (const extra of ["base_iva2", "base_iva3", "cuota_iva2", "cuota_iva3"]) {
      const value = cellAmount(row, col(extra), style);
      if (value && !value.isZero()) extraVatBlocks += 1;
    }
    const fechaFactura = get(row, col("fecha_factura"));
    const fechaFacturaIso = fechaFactura && fechaFactura.trim() !== "" ? parseCellDate(fechaFactura, kindOf(row, col("fecha_factura"))) : null;
    if (fechaFactura && fechaFactura.trim() !== "" && !fechaFacturaIso) fail(`la fecha de factura no es válida (columna ${col("fecha_factura")! + 1})`);

    rows.push({
      line: row.line,
      orden: position + 1,
      empresa: cellCode(get(row, col("empresa"))) ?? options.companyCode ?? "1",
      ejercicio,
      asiento: String(Number(asiento) || asiento),
      fecha,
      periodo,
      cuenta,
      debe: debe.toFixed(2),
      haber: haber.toFixed(2),
      concepto: cellText(get(row, col("concepto"))),
      documento: cellText(get(row, col("documento"))),
      canal: cellCode(get(row, col("canal"))),
      delegacion: cellCode(get(row, col("delegacion"))),
      departamento: cellCode(get(row, col("departamento"))),
      seccion: cellCode(get(row, col("seccion"))),
      proyecto: cellCode(get(row, col("proyecto"))),
      serie: cellText(get(row, col("serie"))),
      factura: cellCode(get(row, col("factura"))),
      su_factura_no: cellText(get(row, col("su_factura_no"))),
      fecha_factura: fechaFacturaIso,
      nif: cellText(get(row, col("nif")))?.replace(/[\s-]/g, "").toUpperCase() ?? null,
      nombre: cellText(get(row, col("nombre"))),
      base_iva: baseIva ? baseIva.toFixed(2) : null,
      tipo_iva: parseRateCode(get(row, col("tipo_iva"))),
      cuota_iva: cuotaIva ? cuotaIva.toFixed(2) : null,
      tipo_factura: cellText(get(row, col("tipo_factura")))?.toUpperCase() ?? null,
      diario: cellCode(get(row, col("diario"))),
      contrapartida: cellCode(get(row, col("contrapartida")))
    });
  });

  if (errors.length > 0) throw invalidFileError(errors);
  if (rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El fichero no contiene apuntes.");
  if (companyDefaulted) warnings.push(`El fichero no trae columna de empresa: se asume el código «${options.companyCode ?? "1"}».`);
  if (negativeSwaps > 0) warnings.push(`${negativeSwaps} apuntes con importe negativo: se han pasado al lado contrario.`);
  if (extraVatBlocks > 0) warnings.push(`${extraVatBlocks} apuntes traen un segundo o tercer bloque de IVA (BaseIva2/3): solo se importa el primero.`);
  if (col("periodo") === undefined) markOpeningPeriods(rows);
  return { rows, warnings, unknownHeaders: match.unknownHeaders, numberStyle: style };
}

function applySideAmount(row: ParsedRow, sideColumn: number, amountColumn: number, style: NumberStyle, fail: (message: string) => void): { debe: Decimal; haber: Decimal; swapped: boolean } | null {
  const marker = row.cells[sideColumn] ?? "";
  const isDebit = isDebitMarker(marker);
  if (isDebit === null) {
    fail(`el indicador Cargo/Abono no es D ni H (columna ${sideColumn + 1})`);
    return null;
  }
  const amount = cellAmount(row, amountColumn, style);
  if (amount === null || amount === undefined) {
    fail("el importe del apunte está vacío o no es numérico");
    return null;
  }
  const debit = amount.isNegative() ? !isDebit : isDebit;
  const abs = amount.abs();
  return { debe: debit ? abs : money(0), haber: debit ? money(0) : abs, swapped: amount.isNegative() };
}

/**
 * Sin columna de periodo: es la apertura (→ periodo "0") el asiento fechado el 1 de enero del
 * ejercicio cuyas líneas son TODAS de grupos 1-5, tocan al menos dos grupos distintos de
 * balance y cuyo concepto dice «apertura» [S]. Un traspaso 572 → 570 del 1 de enero, un cobro o
 * una «Apertura cuenta bancaria nueva» (un solo grupo) siguen siendo asientos del periodo 1.
 */
function markOpeningPeriods(rows: CanonicalJournalRow[]): void {
  const groups = new Map<string, CanonicalJournalRow[]>();
  for (const row of rows) {
    const key = `${row.empresa}|${row.ejercicio}|${row.asiento}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  for (const lines of groups.values()) {
    const first = lines[0]!;
    if (first.fecha !== `${first.ejercicio}-01-01`) continue;
    if (!lines.every((line) => line.fecha === first.fecha && /^[1-5]/.test(line.cuenta))) continue;
    if (new Set(lines.map((line) => line.cuenta.charAt(0))).size < 2) continue;
    if (!lines.some((line) => /apertura/i.test(line.concepto ?? ""))) continue;
    for (const line of lines) line.periodo = SAGE_PERIOD_CODES.opening;
  }
}

export type BalancesTableOptions = {
  synonyms: HeaderSynonyms;
  companyCode?: string;
  fiscalYearCode?: string;
  /** Periodo del fichero cuando no trae columna ("YYYY-MM", "YYYY-Qn", "YYYY" o "apertura"). */
  periodCode?: string;
  /** Centro del fichero cuando no trae columna (hoja de una delegación). */
  propertyCode?: string;
};

/**
 * Tabla → filas de saldos canónicas: apertura (Debe/Haber o saldo con signo), Debe/Haber del
 * periodo y saldo (Deudor/Acreedor o saldo con signo; sin columna de saldo se calcula
 * apertura + debe − haber).
 */
export function parseBalancesTable(table: ParsedTable, options: BalancesTableOptions): TableParseResult<CanonicalBalanceRow> {
  const match = matchColumns(table.header, options.synonyms);
  const warnings = [...table.warnings, ...match.warnings];
  const col = (field: string): number | undefined => match.index.get(field);
  if (col("cuenta") === undefined) throw invalidFileError([{ line: 1, message: "falta la columna obligatoria: cuenta" }], "La cabecera no tiene la columna «cuenta».");
  if (col("debe") === undefined && col("haber") === undefined && col("saldo") === undefined && col("saldo_deudor") === undefined && col("saldo_acreedor") === undefined) {
    throw invalidFileError([{ line: 1, message: "faltan las columnas de importes: debe / haber o saldo" }], "La cabecera no tiene columnas de importes (debe / haber / saldo).");
  }
  for (const header of match.unknownHeaders) warnings.push(`Columna «${header}» no reconocida: se ignora.`);
  const style = detectNumberStyle(amountSamples(table, [col("debe"), col("haber"), col("saldo"), col("saldo_deudor"), col("saldo_acreedor"), col("apertura_debe"), col("apertura_haber"), col("saldo_apertura")]));
  const errors: LedgerImportLineError[] = [];
  const rows: CanonicalBalanceRow[] = [];
  const zero = money(0);
  let computedClosing = 0;
  const totalFolded = new Set(["total", "totales", "suma", "sumas", "total_general", "totales_generales"]);

  for (const row of table.rows) {
    const fail = (message: string): void => {
      if (errors.length < MAX_ERRORS) errors.push({ line: row.line, message });
    };
    const cuentaRaw = get(row, col("cuenta"));
    const cuenta = cellCode(cuentaRaw);
    if (!cuenta) continue; // filas de totales o separadores del listado
    if (totalFolded.has(foldHeader(cuenta))) continue;
    const amount = (field: string): Decimal | null => {
      const value = cellAmount(row, col(field), style);
      if (value === null && (get(row, col(field))?.trim() ?? "") !== "") {
        fail(`el importe de «${field}» no es numérico`);
        return null;
      }
      return value ?? null;
    };
    let aperturaDebe = amount("apertura_debe") ?? zero;
    let aperturaHaber = amount("apertura_haber") ?? zero;
    const saldoApertura = amount("saldo_apertura");
    if (saldoApertura !== null && col("apertura_debe") === undefined && col("apertura_haber") === undefined) {
      if (saldoApertura.isNegative()) aperturaHaber = saldoApertura.abs();
      else aperturaDebe = saldoApertura;
    }
    const debe = amount("debe") ?? zero;
    const haber = amount("haber") ?? zero;
    let saldoDeudor = amount("saldo_deudor");
    let saldoAcreedor = amount("saldo_acreedor");
    const saldo = amount("saldo");
    if (saldoDeudor === null && saldoAcreedor === null) {
      if (saldo !== null && col("saldo") !== undefined) {
        saldoDeudor = saldo.isNegative() ? zero : saldo;
        saldoAcreedor = saldo.isNegative() ? saldo.abs() : zero;
      } else {
        const net = aperturaDebe.minus(aperturaHaber).plus(debe).minus(haber);
        saldoDeudor = net.isNegative() ? zero : net;
        saldoAcreedor = net.isNegative() ? net.abs() : zero;
        computedClosing += 1;
      }
    }
    if (debe.isNegative() || haber.isNegative()) {
      fail("las sumas Debe / Haber no pueden ser negativas");
      continue;
    }
    const ejercicioRaw = cellCode(get(row, col("ejercicio"))) ?? options.fiscalYearCode ?? null;
    const periodoRaw = get(row, col("periodo"));
    let periodo: string | null;
    if (periodoRaw !== undefined && cellText(periodoRaw) !== null) periodo = normalizeBalancePeriod(periodoRaw, ejercicioRaw);
    else periodo = options.periodCode ?? null;
    if (!periodo) {
      fail(periodoRaw === undefined ? "el fichero no trae columna de periodo y no se indicó el periodo del lote" : "el periodo no se reconoce");
      continue;
    }
    const ejercicio = ejercicioRaw ?? (/^(\d{4})/.exec(periodo)?.[1] ?? null);
    if (!ejercicio || !/^\d{4}$/.test(ejercicio)) {
      fail("no se pudo determinar el ejercicio (columna ejercicio o periodo con año)");
      continue;
    }
    rows.push({
      line: row.line,
      empresa: cellCode(get(row, col("empresa"))) ?? options.companyCode ?? "1",
      ejercicio: String(Number(ejercicio)),
      periodo,
      cuenta,
      titulo: cellText(get(row, col("titulo"))),
      delegacion: cellCode(get(row, col("delegacion"))) ?? options.propertyCode ?? null,
      apertura_debe: aperturaDebe.toFixed(2),
      apertura_haber: aperturaHaber.toFixed(2),
      debe: debe.toFixed(2),
      haber: haber.toFixed(2),
      saldo_deudor: (saldoDeudor ?? zero).toFixed(2),
      saldo_acreedor: (saldoAcreedor ?? zero).toFixed(2)
    });
  }
  if (errors.length > 0) throw invalidFileError(errors);
  if (rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El fichero no contiene cuentas con saldos.");
  if (computedClosing > 0) warnings.push(`${computedClosing} cuentas sin saldo informado: se ha calculado como apertura + debe − haber.`);
  return { rows, warnings, unknownHeaders: match.unknownHeaders, numberStyle: style };
}

export function parsePlanTable(table: ParsedTable, options: { synonyms: HeaderSynonyms }): TableParseResult<CanonicalPlanRow> {
  const match = matchColumns(table.header, options.synonyms);
  const warnings = [...table.warnings, ...match.warnings];
  const col = (field: string): number | undefined => match.index.get(field);
  if (col("cuenta") === undefined) throw invalidFileError([{ line: 1, message: "falta la columna obligatoria: cuenta" }], "La cabecera no tiene la columna «cuenta».");
  for (const header of match.unknownHeaders) warnings.push(`Columna «${header}» no reconocida: se ignora.`);
  const rows: CanonicalPlanRow[] = [];
  const errors: LedgerImportLineError[] = [];
  const seen = new Set<string>();
  for (const row of table.rows) {
    const cuenta = cellCode(get(row, col("cuenta")));
    if (!cuenta) continue;
    if (seen.has(cuenta)) {
      if (errors.length < MAX_ERRORS) errors.push({ line: row.line, message: `la cuenta ${cuenta} está repetida` });
      continue;
    }
    seen.add(cuenta);
    const longitudRaw = cellCode(get(row, col("longitud")));
    const longitud = longitudRaw && /^\d{1,2}$/.test(longitudRaw) ? Number(longitudRaw) : null;
    rows.push({
      line: row.line,
      cuenta,
      titulo: cellText(get(row, col("titulo"))),
      nif: cellText(get(row, col("nif")))?.replace(/[\s-]/g, "").toUpperCase() ?? null,
      pais: cellText(get(row, col("pais")))?.toUpperCase() ?? null,
      longitud
    });
  }
  if (errors.length > 0) throw invalidFileError(errors);
  if (rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El fichero no contiene cuentas.");
  return { rows, warnings, unknownHeaders: match.unknownHeaders };
}

export type ThirdPartiesTableOptions = {
  synonyms: HeaderSynonyms;
  /** Rol por defecto cuando no hay columna de rol ni cuenta que lo delate. */
  defaultRole?: "customer" | "supplier";
};

function roleOf(raw: string | undefined, cuenta: string | null, header: { customer: boolean; supplier: boolean }, fallback: "customer" | "supplier" | undefined): "customer" | "supplier" | null {
  const text = raw ? foldHeader(raw) : "";
  if (text !== "") {
    if (/^(c|cl|cli|cliente|clientes|customer|deudor)$/.test(text)) return "customer";
    if (/^(p|pr|prov|proveedor|proveedores|supplier|acreedor|vendor)$/.test(text)) return "supplier";
    return null;
  }
  if (cuenta) {
    if (/^(430|431|435|436|440)/.test(cuenta)) return "customer";
    if (/^(400|401|410|411)/.test(cuenta)) return "supplier";
  }
  if (header.customer && !header.supplier) return "customer";
  if (header.supplier && !header.customer) return "supplier";
  return fallback ?? null;
}

export function parseThirdPartiesTable(table: ParsedTable, options: ThirdPartiesTableOptions): TableParseResult<CanonicalThirdPartyRow> {
  const match = matchColumns(table.header, options.synonyms);
  const warnings = [...table.warnings, ...match.warnings];
  const col = (field: string): number | undefined => match.index.get(field);
  if (col("codigo") === undefined) throw invalidFileError([{ line: 1, message: "falta la columna obligatoria: codigo (CodigoCliente / CodigoProveedor)" }], "La cabecera no tiene la columna «codigo».");
  for (const header of match.unknownHeaders) warnings.push(`Columna «${header}» no reconocida: se ignora.`);
  const headerHints = {
    customer: table.header.some((h) => /cliente/i.test(h)),
    supplier: table.header.some((h) => /proveedor/i.test(h))
  };
  const rows: CanonicalThirdPartyRow[] = [];
  const errors: LedgerImportLineError[] = [];
  const seen = new Set<string>();
  for (const row of table.rows) {
    const codigo = cellCode(get(row, col("codigo")));
    if (!codigo) continue;
    const cuenta = cellCode(get(row, col("cuenta")));
    const rol = roleOf(get(row, col("rol")), cuenta, headerHints, options.defaultRole);
    if (!rol) {
      if (errors.length < MAX_ERRORS) errors.push({ line: row.line, message: "no se pudo determinar si el tercero es cliente o proveedor (columna rol o cuenta 43x / 40x / 41x)" });
      continue;
    }
    const key = `${rol}:${codigo}`;
    if (seen.has(key)) {
      if (errors.length < MAX_ERRORS) errors.push({ line: row.line, message: `el ${rol === "customer" ? "cliente" : "proveedor"} ${codigo} está repetido` });
      continue;
    }
    seen.add(key);
    rows.push({
      line: row.line,
      codigo,
      rol,
      cuenta,
      nif: cellText(get(row, col("nif")))?.replace(/[\s-]/g, "").toUpperCase() ?? null,
      pais: cellText(get(row, col("pais")))?.toUpperCase() ?? null,
      nombre: cellText(get(row, col("nombre")))
    });
  }
  if (errors.length > 0) throw invalidFileError(errors);
  if (rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El fichero no contiene terceros.");
  return { rows, warnings, unknownHeaders: match.unknownHeaders };
}

export type VatTableOptions = {
  synonyms: HeaderSynonyms;
  /** Libro de toda la tabla cuando no trae columna `libro` (hoja EXPEDIDAS_INGRESOS → emitidas). */
  book?: "emitidas" | "recibidas";
  companyCode?: string;
  fiscalYearCode?: string;
};

function bookOf(raw: string | undefined, fallback: "emitidas" | "recibidas" | undefined): "emitidas" | "recibidas" | null {
  const text = raw ? foldHeader(raw) : "";
  if (text === "") return fallback ?? null;
  if (/emitid|expedid|ingres|venta|e$/.test(text) && !/recib/.test(text)) return "emitidas";
  if (/recibid|soportad|gasto|compra|r$/.test(text)) return "recibidas";
  return null;
}

function truthy(raw: string | undefined): boolean {
  const text = raw ? foldHeader(raw) : "";
  return text === "si" || text === "s" || text === "x" || text === "1" || text === "true" || text === "r" || text === "rectificativa";
}

export function parseVatTable(table: ParsedTable, options: VatTableOptions): TableParseResult<CanonicalVatRow> {
  const match = matchColumns(table.header, options.synonyms);
  const warnings = [...table.warnings, ...match.warnings];
  const col = (field: string): number | undefined => match.index.get(field);
  const missing: string[] = [];
  for (const field of ["fecha", "numero", "base", "tipo_iva", "cuota"]) if (col(field) === undefined) missing.push(field);
  if (col("libro") === undefined && !options.book) missing.push("libro");
  if (missing.length > 0) throw invalidFileError([{ line: 1, message: `faltan columnas obligatorias: ${missing.join(", ")}` }], `La cabecera del libro no tiene las columnas obligatorias: ${missing.join(", ")}.`);
  for (const header of match.unknownHeaders) warnings.push(`Columna «${header}» no reconocida: se ignora.`);
  const style = detectNumberStyle(amountSamples(table, [col("base"), col("cuota"), col("total"), col("retencion"), col("cuota_recargo")]));
  const rows: CanonicalVatRow[] = [];
  const errors: LedgerImportLineError[] = [];
  for (const row of table.rows) {
    const fail = (message: string): void => {
      if (errors.length < MAX_ERRORS) errors.push({ line: row.line, message });
    };
    const numero = cellCode(get(row, col("numero")));
    const fecha = parseCellDate(get(row, col("fecha")) ?? "", kindOf(row, col("fecha")));
    const base = cellAmount(row, col("base"), style);
    const cuota = cellAmount(row, col("cuota"), style);
    const tipo = parseRateCode(get(row, col("tipo_iva")));
    const libro = bookOf(get(row, col("libro")), options.book);
    if (!numero && !fecha && base === null && cuota === null) continue; // fila vacía o de totales
    if (!numero) fail("el número de factura está vacío");
    if (!fecha) fail("la fecha de expedición no es válida");
    if (base === null || base === undefined) fail("la base imponible está vacía o no es numérica");
    if (cuota === null || cuota === undefined) fail("la cuota de IVA está vacía o no es numérica");
    if (tipo === null) fail("el tipo de IVA está vacío o no es numérico");
    if (!libro) fail("no se reconoce el libro (emitidas / recibidas)");
    if (!numero || !fecha || !base || !cuota || tipo === null || !libro) continue;
    const totalRaw = cellAmount(row, col("total"), style);
    const recargoCuota = cellAmount(row, col("cuota_recargo"), style);
    const retencion = cellAmount(row, col("retencion"), style);
    const deducible = cellAmount(row, col("cuota_deducible"), style);
    const total = totalRaw ?? base.plus(cuota).plus(recargoCuota ?? 0).minus(retencion ?? 0);
    const fechaOperacionRaw = get(row, col("fecha_operacion"));
    const fechaOperacion = fechaOperacionRaw && fechaOperacionRaw.trim() !== "" ? parseCellDate(fechaOperacionRaw, kindOf(row, col("fecha_operacion"))) : null;
    const tipoRectificativa = cellText(get(row, col("tipo_rectificativa")));
    const tipoFactura = cellText(get(row, col("tipo_factura")))?.toUpperCase() ?? null;
    const rectificativa = truthy(get(row, col("rectificativa"))) || (tipoRectificativa !== null) || (tipoFactura !== null && /^R[1-5]$/.test(tipoFactura));
    const ejercicioRaw = cellCode(get(row, col("ejercicio"))) ?? options.fiscalYearCode ?? fecha.slice(0, 4);
    rows.push({
      line: row.line,
      libro,
      empresa: cellCode(get(row, col("empresa"))) ?? options.companyCode ?? "1",
      ejercicio: String(Number(ejercicioRaw) || ejercicioRaw),
      fecha,
      fecha_operacion: fechaOperacion,
      serie: cellText(get(row, col("serie"))),
      numero,
      nif: cellText(get(row, col("nif")))?.replace(/[\s-]/g, "").toUpperCase() ?? null,
      nombre: cellText(get(row, col("nombre"))),
      pais: cellText(get(row, col("pais")))?.toUpperCase() ?? null,
      base: base.toFixed(2),
      tipo_iva: tipo,
      cuota: cuota.toFixed(2),
      total: total.toFixed(2),
      tipo_recargo: parseRateCode(get(row, col("tipo_recargo"))),
      cuota_recargo: recargoCuota ? recargoCuota.toFixed(2) : null,
      tipo_retencion: parseRateCode(get(row, col("tipo_retencion"))),
      retencion: retencion ? retencion.toFixed(2) : null,
      tipo_factura: tipoFactura,
      rectificativa,
      cuota_deducible: deducible ? deducible.toFixed(2) : null
    });
  }
  if (errors.length > 0) throw invalidFileError(errors);
  if (rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El libro no contiene facturas.");
  return { rows, warnings, unknownHeaders: match.unknownHeaders, numberStyle: style };
}

// ---------------------------------------------------------------------------
// Canónico CSV / JSON
// ---------------------------------------------------------------------------

export type CanonicalParseResult<K extends LedgerImportKind> = TableParseResult<CanonicalRowOf<K>> & { kind: K; format: LedgerImportFormat; company: string | null };

export type CanonicalParseOptions = { companyCode?: string; fiscalYearCode?: string; periodCode?: string; propertyCode?: string };

function parseTableByKind<K extends LedgerImportKind>(kind: K, table: ParsedTable, synonyms: HeaderSynonyms, options: CanonicalParseOptions): TableParseResult<CanonicalRowOf<K>> {
  switch (kind) {
    case "journal":
    case "fiscal_years":
      return parseJournalTable(table, { synonyms, companyCode: options.companyCode, fiscalYearCode: options.fiscalYearCode }) as TableParseResult<CanonicalRowOf<K>>;
    case "balances":
      return parseBalancesTable(table, { synonyms, ...options }) as TableParseResult<CanonicalRowOf<K>>;
    case "plan":
      return parsePlanTable(table, { synonyms }) as TableParseResult<CanonicalRowOf<K>>;
    case "third_parties":
      return parseThirdPartiesTable(table, { synonyms }) as TableParseResult<CanonicalRowOf<K>>;
    default:
      return parseVatTable(table, { synonyms, companyCode: options.companyCode, fiscalYearCode: options.fiscalYearCode }) as TableParseResult<CanonicalRowOf<K>>;
  }
}

/** Tabla ya leída con la tabla de sinónimos indicada (la usan el canónico y el dialecto Sage). */
export function parseTableAs<K extends LedgerImportKind>(kind: K, table: ParsedTable, synonyms: HeaderSynonyms, options: CanonicalParseOptions = {}): TableParseResult<CanonicalRowOf<K>> {
  return parseTableByKind(kind, table, synonyms, options);
}

/** CSV canónico (`;`, `,` o tabulador; BOM; coma o punto decimal) → filas canónicas del tipo. */
export function parseCanonicalCsv<K extends LedgerImportKind>(kind: K, input: string | Uint8Array, options: CanonicalParseOptions = {}): CanonicalParseResult<K> {
  const table = typeof input === "string" ? readLedgerTable({ content: input, reader: "csv" }) : readLedgerTable({ bytes: input, reader: "csv" });
  const result = parseTableByKind(kind, table, canonicalSynonymsFor(kind), options);
  return { ...result, kind, format: "canonical_csv", company: options.companyCode ?? null };
}

type CanonicalJsonDocument = { system?: unknown; company?: unknown; kind?: unknown; rows?: unknown };

/**
 * JSON canónico `{ system, company, kind, rows[] }` → filas canónicas: cada fila es un objeto con
 * las columnas canónicas (valores como texto o número); `kind` distinto del pedido →
 * LEDGER_IMPORT_KIND_MISMATCH.
 */
export function parseCanonicalJson<K extends LedgerImportKind>(kind: K, input: string | Uint8Array, options: CanonicalParseOptions = {}): CanonicalParseResult<K> {
  const text = typeof input === "string" ? input.replace(/^\uFEFF/, "") : new TextDecoder("utf-8").decode(input).replace(/^\uFEFF/, "");
  let document: CanonicalJsonDocument;
  try {
    document = JSON.parse(text) as CanonicalJsonDocument;
  } catch {
    throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", "El JSON canónico no se puede leer.", { errors: [{ line: 0, message: "JSON mal formado" }] });
  }
  if (!document || typeof document !== "object" || !Array.isArray(document.rows)) {
    throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", "El JSON canónico debe ser un objeto { system, company, kind, rows[] }.", { errors: [{ line: 0, message: "falta rows[]" }] });
  }
  if (typeof document.kind === "string" && document.kind !== kind && !(kind === "fiscal_years" && document.kind === "journal")) {
    throw new LedgerImportParseError("LEDGER_IMPORT_KIND_MISMATCH", `El JSON es de tipo «${document.kind}» y el lote pedido es «${kind}».`, { fileKind: document.kind, kind });
  }
  if (document.rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El JSON canónico no contiene filas.");
  const columns = new Set<string>();
  for (const raw of document.rows) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const key of Object.keys(raw as Record<string, unknown>)) columns.add(key);
  }
  const header = [...columns];
  const rows: ParsedRow[] = document.rows.map((raw, index) => {
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const cells = header.map((key) => {
      const value = record[key];
      if (value === null || value === undefined) return "";
      if (typeof value === "boolean") return value ? "si" : "no";
      return String(value).trim();
    });
    return { rowNumber: index + 1, line: index + 1, cells, kinds: header.map((key) => (typeof record[key] === "number" ? "number" : record[key] === null || record[key] === undefined || String(record[key]).trim() === "" ? "empty" : "string")) };
  });
  const table: ParsedTable = { header, rows, format: "csv", bom: false, warnings: [], truncated: false };
  const company = typeof document.company === "string" || typeof document.company === "number" ? String(document.company) : null;
  const result = parseTableByKind(kind, table, canonicalSynonymsFor(kind), { ...options, companyCode: options.companyCode ?? company ?? undefined });
  return { ...result, kind, format: "canonical_json", company: options.companyCode ?? company };
}

// ---------------------------------------------------------------------------
// Normalización y hash
// ---------------------------------------------------------------------------

function compareCodes(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : null;
  const nb = /^\d+$/.test(b) ? Number(b) : null;
  if (na !== null && nb !== null) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function trimOrNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text === "" ? null : text;
}

function money2(value: string | null | undefined): MoneyString {
  return money(value ?? 0).toFixed(2);
}

function money2OrNull(value: string | null | undefined): MoneyString | null {
  return value === null || value === undefined || value === "" ? null : money(value).toFixed(2);
}

/**
 * Filas normalizadas: importes a dos decimales, textos recortados (vacío → null), códigos de
 * asiento / ejercicio sin ceros a la izquierda, y ordenadas por (ejercicio, asiento, orden)
 * en el diario, (ejercicio, periodo, delegación, cuenta) en saldos, cuenta en el plan,
 * (rol, código) en terceros y (libro, fecha, serie, número, tipo) en libros. No muta la entrada.
 */
export function normalizeRows<K extends LedgerImportKind>(kind: K, rows: readonly CanonicalRowOf<K>[]): CanonicalRowOf<K>[] {
  switch (kind) {
    case "journal":
    case "fiscal_years": {
      const out = (rows as readonly CanonicalJournalRow[]).map((row) => ({
        ...row,
        empresa: row.empresa.trim(),
        ejercicio: String(Number(row.ejercicio) || row.ejercicio),
        asiento: String(Number(row.asiento) || row.asiento),
        cuenta: row.cuenta.trim(),
        periodo: row.periodo.trim(),
        debe: money2(row.debe),
        haber: money2(row.haber),
        concepto: trimOrNull(row.concepto),
        documento: trimOrNull(row.documento),
        canal: trimOrNull(row.canal),
        delegacion: trimOrNull(row.delegacion),
        departamento: trimOrNull(row.departamento),
        seccion: trimOrNull(row.seccion),
        proyecto: trimOrNull(row.proyecto),
        serie: trimOrNull(row.serie),
        factura: trimOrNull(row.factura),
        su_factura_no: trimOrNull(row.su_factura_no),
        nif: trimOrNull(row.nif)?.replace(/[\s-]/g, "").toUpperCase() ?? null,
        nombre: trimOrNull(row.nombre),
        base_iva: money2OrNull(row.base_iva),
        tipo_iva: trimOrNull(row.tipo_iva),
        cuota_iva: money2OrNull(row.cuota_iva),
        tipo_factura: trimOrNull(row.tipo_factura)?.toUpperCase() ?? null,
        diario: trimOrNull(row.diario),
        contrapartida: trimOrNull(row.contrapartida)
      }));
      out.sort((a, b) => compareCodes(a.ejercicio, b.ejercicio) || compareCodes(a.asiento, b.asiento) || a.orden - b.orden);
      return out as CanonicalRowOf<K>[];
    }
    case "balances": {
      const out = (rows as readonly CanonicalBalanceRow[]).map((row) => ({
        ...row,
        empresa: row.empresa.trim(),
        ejercicio: String(Number(row.ejercicio) || row.ejercicio),
        periodo: row.periodo.trim(),
        cuenta: row.cuenta.trim(),
        titulo: trimOrNull(row.titulo),
        delegacion: trimOrNull(row.delegacion),
        apertura_debe: money2(row.apertura_debe),
        apertura_haber: money2(row.apertura_haber),
        debe: money2(row.debe),
        haber: money2(row.haber),
        saldo_deudor: money2(row.saldo_deudor),
        saldo_acreedor: money2(row.saldo_acreedor)
      }));
      out.sort((a, b) => compareCodes(a.ejercicio, b.ejercicio) || (a.periodo < b.periodo ? -1 : a.periodo > b.periodo ? 1 : 0) || ((a.delegacion ?? "") < (b.delegacion ?? "") ? -1 : (a.delegacion ?? "") > (b.delegacion ?? "") ? 1 : 0) || compareCodes(a.cuenta, b.cuenta));
      return out as CanonicalRowOf<K>[];
    }
    case "plan": {
      const out = (rows as readonly CanonicalPlanRow[]).map((row) => ({ ...row, cuenta: row.cuenta.trim(), titulo: trimOrNull(row.titulo), nif: trimOrNull(row.nif)?.replace(/[\s-]/g, "").toUpperCase() ?? null, pais: trimOrNull(row.pais)?.toUpperCase() ?? null }));
      out.sort((a, b) => compareCodes(a.cuenta, b.cuenta));
      return out as CanonicalRowOf<K>[];
    }
    case "third_parties": {
      const out = (rows as readonly CanonicalThirdPartyRow[]).map((row) => ({ ...row, codigo: row.codigo.trim(), cuenta: trimOrNull(row.cuenta), nif: trimOrNull(row.nif)?.replace(/[\s-]/g, "").toUpperCase() ?? null, pais: trimOrNull(row.pais)?.toUpperCase() ?? null, nombre: trimOrNull(row.nombre) }));
      out.sort((a, b) => (a.rol < b.rol ? -1 : a.rol > b.rol ? 1 : 0) || compareCodes(a.codigo, b.codigo));
      return out as CanonicalRowOf<K>[];
    }
    default: {
      const out = (rows as readonly CanonicalVatRow[]).map((row) => ({
        ...row,
        empresa: row.empresa.trim(),
        ejercicio: String(Number(row.ejercicio) || row.ejercicio),
        serie: trimOrNull(row.serie),
        numero: row.numero.trim(),
        nif: trimOrNull(row.nif)?.replace(/[\s-]/g, "").toUpperCase() ?? null,
        nombre: trimOrNull(row.nombre),
        pais: trimOrNull(row.pais)?.toUpperCase() ?? null,
        base: money2(row.base),
        cuota: money2(row.cuota),
        total: money2(row.total),
        cuota_recargo: money2OrNull(row.cuota_recargo),
        retencion: money2OrNull(row.retencion),
        cuota_deducible: money2OrNull(row.cuota_deducible)
      }));
      out.sort((a, b) => (a.libro < b.libro ? -1 : a.libro > b.libro ? 1 : 0) || (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0) || ((a.serie ?? "") < (b.serie ?? "") ? -1 : (a.serie ?? "") > (b.serie ?? "") ? 1 : 0) || compareCodes(a.numero, b.numero) || compareCodes(a.tipo_iva, b.tipo_iva));
      return out as CanonicalRowOf<K>[];
    }
  }
}

/**
 * Campos que NO entran en el hash: posición en el fichero (`line`, `orden`) y las etiquetas
 * informativas de Sage que el canónico no exige (`diario` solo alimenta la referencia,
 * `contrapartida` es una pista): así el Excel del Diario y el CSV canónico equivalentes
 * dan el mismo hash.
 */
const HASH_EXCLUDED_FIELDS = new Set(["line", "orden", "diario", "contrapartida"]);

function hashProjection(row: CanonicalRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (HASH_EXCLUDED_FIELDS.has(key)) continue;
    out[key] = (row as Record<string, unknown>)[key];
  }
  return out;
}

/**
 * sha256 (hex) del JSON canónico de las filas NORMALIZADAS, antes del mapa de cuentas y del
 * mapa analítico: el mismo diario exportado como Excel o como CSV da el mismo hash, y editar
 * el mapa no lo cambia. Llama a `normalizeRows` si las filas no vienen normalizadas.
 */
export function contentHashOf<K extends LedgerImportKind>(kind: K, normalizedRows: readonly CanonicalRowOf<K>[]): string {
  const canonicalKind = kind === "fiscal_years" ? "journal" : kind;
  const payload = JSON.stringify({ kind: canonicalKind, rows: (normalizedRows as readonly CanonicalRow[]).map(hashProjection) });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Plantilla canónica
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV canónico del tipo: BOM UTF-8, separador «;», cabecera y filas de ejemplo (empresa ficticia). */
export function buildCanonicalTemplate(kind: LedgerImportKind): string {
  if (!(LEDGER_IMPORT_KINDS as readonly string[]).includes(kind)) throw new LedgerImportParseError("VALIDATION_ERROR", `Tipo de lote desconocido: ${kind}.`);
  const header = CANONICAL_COLUMNS[kind];
  const lines = [header.join(";"), ...TEMPLATE_EXAMPLE_ROWS[kind].map((row) => header.map((_, index) => csvCell(row[index] ?? "")).join(";"))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** Nombre de fichero sugerido para la plantilla. */
export function canonicalTemplateFileName(kind: LedgerImportKind): string {
  return `plantilla-sage200-${kind.replace(/_/g, "-")}.csv`;
}

// ---------------------------------------------------------------------------
// Agrupación en asientos Sage
// ---------------------------------------------------------------------------

export type SageJournalEntryKey = {
  companyCode: string;
  fiscalYear: string;
  period: string;
  entryNumber: string;
  /** Canal / delegación cuando Sage numera por canal (`numberingDimension`); null si no. */
  channel: string | null;
};

export type SageJournalEntry = {
  key: SageJournalEntryKey;
  /** Fecha del asiento (la de la primera línea; líneas con otra fecha → aviso). */
  entryDate: IsoDate;
  lines: CanonicalJournalRow[];
  warnings: string[];
};

export type GroupJournalOptions = {
  /** Dimensión que forma parte de la numeración de Sage («Numeración canal/delegación»); null por defecto. */
  numberingDimension?: "canal" | "delegacion" | null;
};

/** Clave de un asiento Sage como texto (para mapas y mensajes): `empresa:ejercicio:periodo:asiento[:canal]`. */
export function sageEntryKeyString(key: SageJournalEntryKey): string {
  return [key.companyCode, key.fiscalYear, key.period, key.entryNumber, ...(key.channel ? [key.channel] : [])].join(":");
}

/**
 * Filas → asientos Sage por (empresa, ejercicio, periodo, asiento[, canal]), en el orden de
 * la primera aparición; las líneas conservan su orden. Dos asientos nº 1 en los periodos 0 y 1
 * son claves distintas (en Sage el número solo es único dentro del periodo).
 */
export function groupJournalRows(rows: readonly CanonicalJournalRow[], options: GroupJournalOptions = {}): SageJournalEntry[] {
  const dimension = options.numberingDimension ?? null;
  const entries = new Map<string, SageJournalEntry>();
  for (const row of rows) {
    const channel = dimension ? (dimension === "canal" ? row.canal : row.delegacion) : null;
    const key: SageJournalEntryKey = { companyCode: row.empresa, fiscalYear: row.ejercicio, period: row.periodo, entryNumber: row.asiento, channel: channel ?? null };
    const id = sageEntryKeyString(key);
    const existing = entries.get(id);
    if (existing) {
      existing.lines.push(row);
      if (row.fecha !== existing.entryDate && !existing.warnings.some((w) => w.startsWith("Líneas con fechas distintas"))) {
        existing.warnings.push(`Líneas con fechas distintas dentro del asiento ${key.fiscalYear}/${key.entryNumber} (periodo ${key.period}): se usa ${existing.entryDate}.`);
      }
    } else entries.set(id, { key, entryDate: row.fecha, lines: [row], warnings: [] });
  }
  return [...entries.values()];
}
