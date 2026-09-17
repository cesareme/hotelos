// XLSX-lite (Tanda 7 · L1) — lector mínimo de libros .xlsx SIN dependencias.
//
// No hay librería XLSX ni ZIP en node_modules y la regla del runbook prohíbe
// añadir paquetes, así que el libro se lee aquí: un contenedor ZIP (fin de
// directorio central → directorio central → cabecera local; métodos 0 y 8 con
// `inflateRawSync` de node:zlib acotado) y las partes SpreadsheetML que hacen
// falta para una tabla: `xl/workbook.xml` (época 1904, hojas y su estado),
// `xl/_rels/workbook.xml.rels` (Id → parte de la hoja), `xl/sharedStrings.xml`
// (runs `<r><t>` concatenados, `<rPh>` ignorado), `xl/styles.xml` (qué estilos
// son de fecha) y `xl/worksheets/sheetN.xml` (valores cacheados `<v>`; las
// fórmulas `<f>` se ignoran).
//
// Qué devuelve: por celda el texto CRUDO (un número nunca se redondea: "312.5"
// se conserva; la notación científica de enteros se expande con BigInt) y su
// `kind` (empty | string | number | bool | date | time | error). Con estilo de
// fecha un serial entero se convierte a ISO (época 1900 con el hueco del
// 29/02/1900 —serial 60— o época 1904) y una fracción de día a "HH:MM".
//
// Límites (diseño §3.3, todos → `XlsxLiteError` tipado): ZIP64 rechazado,
// ≤ 2.000 entradas, cada parte ≤ 32 MiB descomprimida, suma ≤ 64 MiB,
// `maxRows` / `maxCols` / `maxCellChars` de la hoja. Lo que NO lee: fórmulas
// sin `<v>` (celda vacía + aviso), libros cifrados (no son ZIP), formatos
// condicionales. Sin acceso a red ni a disco: entrada `Uint8Array`, salida
// estructura pura; el módulo es determinista y testeable.

import { inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Límites y errores
// ---------------------------------------------------------------------------

/** Entradas máximas del ZIP (un .xlsx normal tiene 10-30). */
export const XLSX_LITE_MAX_ENTRIES = 2000;
/** Tamaño máximo descomprimido de una parte (hoja, sharedStrings…). */
export const XLSX_LITE_MAX_PART_BYTES = 32 * 1024 * 1024;
/** Suma máxima de los tamaños descomprimidos declarados en el directorio central. */
export const XLSX_LITE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Avisos máximos conservados por lectura (después se resume «… y N más»). */
export const XLSX_LITE_MAX_WARNINGS = 50;
/** Último serial válido de la época 1900 (9999-12-31). */
export const XLSX_MAX_SERIAL_1900 = 2958465;
/** Último serial válido de la época 1904 (9999-12-31). */
export const XLSX_MAX_SERIAL_1904 = 2957003;

export type XlsxLiteErrorCode =
  | "XLSX_NOT_ZIP"
  | "XLSX_ZIP64"
  | "XLSX_TOO_MANY_ENTRIES"
  | "XLSX_BOMB"
  | "XLSX_COMPRESSION"
  | "XLSX_NO_WORKBOOK"
  | "XLSX_NO_SHEET"
  | "XLSX_BAD_XML"
  | "XLSX_BAD_DATE";

/** Error tipado del lector: el parser de importación lo traduce a RESERVATION_IMPORT_UNREADABLE. */
export class XlsxLiteError extends Error {
  readonly code: XlsxLiteErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: XlsxLiteErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "XlsxLiteError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// ZIP: directorio central + cabecera local
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_MARK_32 = 0xffffffff;
const ZIP64_MARK_16 = 0xffff;

export type ZipEntryInfo = {
  /** Nombre normalizado (separador «/», sin «/» inicial). */
  name: string;
  /** 0 = almacenado, 8 = deflate. */
  method: number;
  /** Bits de propósito general (bit 3 = data descriptor: los tamaños fiables son los del directorio central). */
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Nombre de parte canónico: «\» → «/», sin «/» ni «./» iniciales. */
export function normalizeZipName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");
}

/**
 * Lee el fin de directorio central (buscado desde `len - 22` hacia atrás, comentario
 * ≤ 65.535 bytes) y después cada cabecera central. Rechaza ZIP64, más de 2.000
 * entradas, partes > 32 MiB y sumas > 64 MiB declaradas.
 */
export function readZipCentralDirectory(bytes: Uint8Array): ZipEntryInfo[] {
  const buf = asBuffer(bytes);
  if (buf.length < 22 || buf.readUInt32LE(0) !== SIG_LOCAL) {
    throw new XlsxLiteError("XLSX_NOT_ZIP", "El fichero no es un libro .xlsx (no es un contenedor ZIP).");
  }
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let offset = buf.length - 22; offset >= floor; offset -= 1) {
    if (buf.readUInt32LE(offset) === SIG_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new XlsxLiteError("XLSX_NOT_ZIP", "El fichero no es un libro .xlsx (falta el fin del directorio central).");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    throw new XlsxLiteError("XLSX_ZIP64", "El libro usa ZIP64 y no se admite: guárdalo de nuevo como .xlsx normal.");
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === ZIP64_MARK_16 || cdSize === ZIP64_MARK_32 || cdOffset === ZIP64_MARK_32) {
    throw new XlsxLiteError("XLSX_ZIP64", "El libro usa ZIP64 y no se admite: guárdalo de nuevo como .xlsx normal.");
  }
  if (entryCount > XLSX_LITE_MAX_ENTRIES) {
    throw new XlsxLiteError("XLSX_TOO_MANY_ENTRIES", `El libro tiene ${entryCount} partes y el máximo admitido es ${XLSX_LITE_MAX_ENTRIES}.`, {
      entries: entryCount,
      max: XLSX_LITE_MAX_ENTRIES
    });
  }
  if (cdOffset + cdSize > buf.length) {
    throw new XlsxLiteError("XLSX_NOT_ZIP", "El fichero no es un libro .xlsx (directorio central fuera del fichero).");
  }

  const entries: ZipEntryInfo[] = [];
  let offset = cdOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new XlsxLiteError("XLSX_NOT_ZIP", "El fichero no es un libro .xlsx (directorio central corrupto).");
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    if (compressedSize === ZIP64_MARK_32 || uncompressedSize === ZIP64_MARK_32 || localHeaderOffset === ZIP64_MARK_32) {
      throw new XlsxLiteError("XLSX_ZIP64", "El libro usa ZIP64 y no se admite: guárdalo de nuevo como .xlsx normal.");
    }
    if (uncompressedSize > XLSX_LITE_MAX_PART_BYTES) {
      throw new XlsxLiteError("XLSX_BOMB", "Una parte del libro supera los 32 MiB descomprimida: el fichero no se admite.", {
        part: index,
        bytes: uncompressedSize,
        max: XLSX_LITE_MAX_PART_BYTES
      });
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > XLSX_LITE_MAX_TOTAL_BYTES) {
      throw new XlsxLiteError("XLSX_BOMB", "El libro supera los 64 MiB descomprimidos en total: el fichero no se admite.", {
        bytes: totalUncompressed,
        max: XLSX_LITE_MAX_TOTAL_BYTES
      });
    }
    const nameStart = offset + 46;
    if (nameStart + nameLength > buf.length) {
      throw new XlsxLiteError("XLSX_NOT_ZIP", "El fichero no es un libro .xlsx (nombre de parte fuera del fichero).");
    }
    const name = normalizeZipName(buf.toString("utf8", nameStart, nameStart + nameLength));
    entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Descomprime una entrada leyendo su cabecera local para localizar los datos y
 * usando los tamaños del DIRECTORIO CENTRAL (fiables aunque la entrada lleve data
 * descriptor y la cabecera local declare 0). Método 0 copia; 8 → `inflateRawSync`
 * acotado a 32 MiB (`XLSX_BOMB` si se supera); otro → `XLSX_COMPRESSION`.
 */
export function inflateZipEntry(bytes: Uint8Array, entry: ZipEntryInfo): Buffer {
  const buf = asBuffer(bytes);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== SIG_LOCAL) {
    throw new XlsxLiteError("XLSX_NOT_ZIP", "El fichero no es un libro .xlsx (cabecera local corrupta).", { part: entry.name });
  }
  const nameLength = buf.readUInt16LE(offset + 26);
  const extraLength = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new XlsxLiteError("XLSX_NOT_ZIP", "El fichero no es un libro .xlsx (datos de una parte fuera del fichero).", { part: entry.name });
  }
  const data = buf.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method !== 8) {
    throw new XlsxLiteError("XLSX_COMPRESSION", `La parte usa un método de compresión no admitido (${entry.method}).`, {
      part: entry.name,
      method: entry.method
    });
  }
  try {
    return inflateRawSync(data, { maxOutputLength: XLSX_LITE_MAX_PART_BYTES });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new XlsxLiteError("XLSX_BOMB", "Una parte del libro supera los 32 MiB descomprimida: el fichero no se admite.", {
        part: entry.name,
        max: XLSX_LITE_MAX_PART_BYTES
      });
    }
    throw new XlsxLiteError("XLSX_COMPRESSION", "No se ha podido descomprimir una parte del libro.", { part: entry.name });
  }
}

/** Acceso perezoso por nombre (cada parte se descomprime una sola vez). */
class ZipReader {
  private readonly bytes: Buffer;
  private readonly byName = new Map<string, ZipEntryInfo>();
  private readonly byLowerName = new Map<string, ZipEntryInfo>();
  private readonly cache = new Map<string, Buffer>();

  constructor(bytes: Uint8Array) {
    this.bytes = asBuffer(bytes);
    for (const entry of readZipCentralDirectory(this.bytes)) {
      if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry);
      const lower = entry.name.toLowerCase();
      if (!this.byLowerName.has(lower)) this.byLowerName.set(lower, entry);
    }
  }

  has(name: string): boolean {
    const key = normalizeZipName(name);
    return this.byName.has(key) || this.byLowerName.has(key.toLowerCase());
  }

  read(name: string): Buffer | null {
    const key = normalizeZipName(name);
    const entry = this.byName.get(key) ?? this.byLowerName.get(key.toLowerCase());
    if (!entry) return null;
    const cached = this.cache.get(entry.name);
    if (cached) return cached;
    const data = inflateZipEntry(this.bytes, entry);
    this.cache.set(entry.name, data);
    return data;
  }

  text(name: string): string | null {
    const data = this.read(name);
    return data ? data.toString("utf8") : null;
  }
}

// ---------------------------------------------------------------------------
// Helpers XML y de Excel (exportados para los tests)
// ---------------------------------------------------------------------------

const ENTITY_RE = /&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]{1,6}|#[0-9]{1,7});/g;
const X_ESCAPE_RE = /_x([0-9A-Fa-f]{4})_/g;

/** Entidades XML (`&lt; &gt; &amp; &quot; &apos; &#N; &#xH;`) y escapes de Excel `_xHHHH_` (`_x000D_` → CR). */
export function decodeXmlText(text: string): string {
  if (!text) return "";
  let out = text;
  if (out.indexOf("&") >= 0) {
    out = out.replace(ENTITY_RE, (whole, entity: string) => {
      switch (entity) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "amp":
          return "&";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default: {
          const codePoint = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
          if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return whole;
          }
        }
      }
    });
  }
  if (out.indexOf("_x") >= 0) {
    out = out.replace(X_ESCAPE_RE, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return out;
}

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Atributos de una etiqueta (`name="v"` o `name='v'`), sin decodificar entidades. */
function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(tag)) !== null) {
    out[match[1]!] = match[2] ?? match[3] ?? "";
  }
  return out;
}

/** Prefijo de espacio de nombres opcional (`<x:row>`), inofensivo en los libros normales. */
const P = "(?:[A-Za-z_][\\w.-]*:)?";
const T_RE = new RegExp(`<${P}t\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}t>)`, "g");
const RPH_RE = new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, "g");

/** Concatena todos los `<t>` de un `<si>` o `<is>` (runs `<r><t>` incluidos), ignorando `<rPh>`. */
function joinTextRuns(xml: string): string {
  const cleaned = xml.indexOf("rPh") >= 0 ? xml.replace(RPH_RE, "") : xml;
  let out = "";
  T_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = T_RE.exec(cleaned)) !== null) {
    out += decodeXmlText(match[2] ?? "");
  }
  return out;
}

/** Índice de columna 1-based de una referencia A1 (`"AB12"` → 28, `"A"` → 1). */
export function columnIndexFromRef(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref);
  if (!letters) throw new XlsxLiteError("XLSX_BAD_XML", "Referencia de celda no válida en la hoja.", { ref });
  let index = 0;
  for (const char of letters[0].toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

const BUILTIN_DATE_FMT_IDS = new Set<number>([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58
]);

/**
 * ¿El formato numérico es de fecha u hora? Ids incorporados 14-22, 27-36, 45-47,
 * 50-58, o un `formatCode` con d/m/y/h/s una vez quitados los tramos literales
 * `"…"`, los `[…]` (colores, condiciones, monedas) y los escapes `\x`.
 */
export function isDateNumFmt(numFmtId: number, formatCode?: string): boolean {
  if (BUILTIN_DATE_FMT_IDS.has(numFmtId)) return true;
  if (!formatCode) return false;
  const stripped = formatCode
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[dmyhs]/i.test(stripped);
}

const DAY_MS = 86400000;

/**
 * Serial de Excel → "YYYY-MM-DD". Época 1900: 1..59 → 1899-12-31 + días, 60 →
 * error (el 29/02/1900 no existe), ≥ 61 → 1899-12-30 + días; época 1904: 0.. →
 * 1904-01-01 + días. La parte fraccionaria (hora) se ignora.
 */
export function excelSerialToIso(serial: number, date1904 = false): string {
  if (!Number.isFinite(serial)) throw new XlsxLiteError("XLSX_BAD_DATE", "El serial de fecha no es un número.");
  const day = Math.floor(serial);
  let base: number;
  if (date1904) {
    if (day < 0 || day > XLSX_MAX_SERIAL_1904) throw new XlsxLiteError("XLSX_BAD_DATE", "El serial de fecha está fuera del calendario (época 1904).", { serial: day });
    base = Date.UTC(1904, 0, 1);
  } else {
    if (day < 1 || day > XLSX_MAX_SERIAL_1900) throw new XlsxLiteError("XLSX_BAD_DATE", "El serial de fecha está fuera del calendario (época 1900).", { serial: day });
    if (day === 60) throw new XlsxLiteError("XLSX_BAD_DATE", "El serial 60 corresponde al 29/02/1900, que no existe.", { serial: day });
    base = day < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  }
  return new Date(base + day * DAY_MS).toISOString().slice(0, 10);
}

/** Fracción de día (0 ≤ f < 1) → "HH:MM" (redondeo al minuto; 0.6875 → 16:30). */
export function excelFractionToTime(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new XlsxLiteError("XLSX_BAD_DATE", "La fracción de hora está fuera de 0..1.", { fraction });
  }
  const minutes = Math.min(1439, Math.round(fraction * 1440));
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

const SCIENTIFIC_RE = /^([-+]?)(\d+)(?:\.(\d+))?[eE]([-+]?\d+)$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/**
 * Tope de dígitos que se aceptan expandir (mantisa, o ceros añadidos a
 * cualquiera de los dos lados de la coma). Excel guarda como mucho 17 dígitos
 * significativos y exponentes hasta ±308: cualquier valor por encima es un
 * fichero hostil (`9E900000000` → `10n ** 900000000n`, `1E-2000000000` →
 * `"0".repeat(2e9)`) y se conserva como texto sin expandir (SEC-T7-01).
 */
export const MAX_SCIENTIFIC_DIGITS = 400;

/**
 * Expande la notación científica que Excel guarda para enteros grandes
 * (`6.00123456E8` → `600123456`) con BigInt, sin pasar por float. Un exponente
 * negativo o una mantisa más larga que el exponente producen decimales exactos
 * (`1.5E-3` → `0.0015`). Devuelve `{ text, unsafe }` (unsafe = entero > 2^53,
 * o valor que no se expande porque supera `MAX_SCIENTIFIC_DIGITS`).
 */
export function expandScientific(raw: string): { text: string; unsafe: boolean } {
  // Antes de la expresión regular: una «celda» de megabytes no se analiza.
  if (raw.length > MAX_SCIENTIFIC_DIGITS + 8) return { text: raw, unsafe: /[eE]/.test(raw) };
  const match = SCIENTIFIC_RE.exec(raw);
  if (!match) return { text: raw, unsafe: false };
  const sign = match[1] === "-" ? "-" : "";
  const intPart = match[2]!;
  const fracPart = match[3] ?? "";
  const exponent = Number.parseInt(match[4]!, 10);
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  // Exponente o mantisa desmesurados: ni BigInt ni String.repeat (DoS por CPU / memoria).
  if (!Number.isFinite(exponent) || Math.abs(exponent) > MAX_SCIENTIFIC_DIGITS || digits.length > MAX_SCIENTIFIC_DIGITS) {
    return { text: raw, unsafe: true };
  }
  const pointPosition = intPart.length + exponent; // dígitos a la izquierda de la coma
  let text: string;
  let unsafe = false;
  if (pointPosition >= digits.length) {
    const value = BigInt(digits) * 10n ** BigInt(pointPosition - digits.length);
    unsafe = value > MAX_SAFE;
    text = value.toString();
  } else if (pointPosition <= 0) {
    text = `0.${"0".repeat(-pointPosition)}${digits}`.replace(/\.?0+$/, "");
    if (text === "0" || text === "") text = "0";
  } else {
    const left = digits.slice(0, pointPosition).replace(/^0+(?=\d)/, "");
    const right = digits.slice(pointPosition).replace(/0+$/, "");
    text = right ? `${left}.${right}` : left;
  }
  if (text === "0") return { text: "0", unsafe: false };
  return { text: `${sign}${text}`, unsafe };
}

// ---------------------------------------------------------------------------
// Partes del libro
// ---------------------------------------------------------------------------

type WorkbookSheet = { name: string; sheetId: string; relId: string | null; hidden: boolean; index: number };

const WORKBOOK_PR_RE = new RegExp(`<${P}workbookPr\\b([^>]*?)/?>`);
const SHEET_RE = new RegExp(`<${P}sheet\\b([^>]*?)/?>`, "g");
const RELATIONSHIP_RE = new RegExp(`<${P}Relationship\\b([^>]*?)/?>`, "g");
const SI_RE = new RegExp(`<${P}si\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}si>)`, "g");
const NUMFMT_RE = new RegExp(`<${P}numFmt\\b([^>]*?)/?>`, "g");
const CELLXFS_RE = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)</${P}cellXfs>`);
const XF_RE = new RegExp(`<${P}xf\\b([^>]*?)(?:/>|>[\\s\\S]*?</${P}xf>)`, "g");
const SHEETDATA_RE = new RegExp(`<${P}sheetData\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}sheetData>)`);
const ROW_RE = new RegExp(`<${P}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}row>)`, "g");
const CELL_RE = new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, "g");
const V_RE = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)</${P}v>`);
const IS_RE = new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)</${P}is>`);

function officeDocumentPart(zip: ZipReader): string {
  const rels = zip.text("_rels/.rels");
  if (rels) {
    RELATIONSHIP_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RELATIONSHIP_RE.exec(rels)) !== null) {
      const attrs = parseAttrs(match[1] ?? "");
      if ((attrs.Type ?? "").endsWith("/officeDocument") && attrs.Target) return normalizeZipName(decodeXmlText(attrs.Target));
    }
  }
  return "xl/workbook.xml";
}

function readWorkbook(zip: ZipReader): { part: string; date1904: boolean; sheets: WorkbookSheet[] } {
  const part = officeDocumentPart(zip);
  const xml = zip.text(part) ?? zip.text("xl/workbook.xml");
  if (!xml) throw new XlsxLiteError("XLSX_NO_WORKBOOK", "El libro no contiene xl/workbook.xml: no es un .xlsx válido.");
  const prMatch = WORKBOOK_PR_RE.exec(xml);
  const date1904Raw = prMatch ? (parseAttrs(prMatch[1] ?? "").date1904 ?? "") : "";
  const date1904 = date1904Raw === "1" || date1904Raw.toLowerCase() === "true";
  const sheets: WorkbookSheet[] = [];
  SHEET_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SHEET_RE.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1] ?? "");
    const relKey = Object.keys(attrs).find((key) => key === "r:id" || key.endsWith(":id"));
    const state = (attrs.state ?? "visible").toLowerCase();
    sheets.push({
      name: decodeXmlText(attrs.name ?? ""),
      sheetId: attrs.sheetId ?? String(sheets.length + 1),
      relId: relKey ? attrs[relKey]! : null,
      hidden: state === "hidden" || state === "veryhidden",
      index: sheets.length
    });
  }
  if (sheets.length === 0) throw new XlsxLiteError("XLSX_NO_SHEET", "El libro no tiene hojas.");
  return { part, date1904, sheets };
}

function readWorkbookRels(zip: ZipReader, workbookPart: string): Map<string, string> {
  const slash = workbookPart.lastIndexOf("/");
  const dir = slash >= 0 ? workbookPart.slice(0, slash) : "";
  const file = slash >= 0 ? workbookPart.slice(slash + 1) : workbookPart;
  const relsPart = `${dir ? `${dir}/` : ""}_rels/${file}.rels`;
  const xml = zip.text(relsPart) ?? zip.text("xl/_rels/workbook.xml.rels");
  const out = new Map<string, string>();
  if (!xml) return out;
  RELATIONSHIP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIONSHIP_RE.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1] ?? "");
    if (!attrs.Id || !attrs.Target) continue;
    const target = decodeXmlText(attrs.Target);
    // Target absoluto («/xl/worksheets/sheet1.xml») → sin «/» inicial; relativo → junto al workbook.
    const resolved = target.startsWith("/") ? normalizeZipName(target) : normalizeZipName(`${dir ? `${dir}/` : ""}${target}`);
    out.set(attrs.Id, resolved);
  }
  return out;
}

function readSharedStrings(zip: ZipReader): string[] {
  const xml = zip.text("xl/sharedStrings.xml");
  if (!xml) return [];
  const out: string[] = [];
  SI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SI_RE.exec(xml)) !== null) {
    out.push(joinTextRuns(match[2] ?? ""));
  }
  return out;
}

/** Índice de `cellXfs` → ¿estilo de fecha u hora? */
function readDateStyles(zip: ZipReader): boolean[] {
  const xml = zip.text("xl/styles.xml");
  if (!xml) return [];
  const formats = new Map<number, string>();
  NUMFMT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMFMT_RE.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1] ?? "");
    const id = Number.parseInt(attrs.numFmtId ?? "", 10);
    if (Number.isFinite(id)) formats.set(id, decodeXmlText(attrs.formatCode ?? ""));
  }
  const block = CELLXFS_RE.exec(xml);
  if (!block) return [];
  const styles: boolean[] = [];
  XF_RE.lastIndex = 0;
  while ((match = XF_RE.exec(block[1] ?? "")) !== null) {
    const attrs = parseAttrs(match[1] ?? "");
    const id = Number.parseInt(attrs.numFmtId ?? "0", 10);
    styles.push(isDateNumFmt(Number.isFinite(id) ? id : 0, formats.get(id)));
  }
  return styles;
}

// ---------------------------------------------------------------------------
// Tabla de una hoja
// ---------------------------------------------------------------------------

export type CellKind = "empty" | "string" | "number" | "bool" | "date" | "time" | "error";

export type XlsxCell = {
  /** Texto crudo: números tal cual (sin redondear), fechas ISO, horas HH:MM, TRUE/FALSE. */
  raw: string;
  kind: CellKind;
  /** La celda lleva un estilo de fecha u hora. */
  dateStyle: boolean;
};

export type XlsxRow = {
  /** Número de fila de la hoja (1-based), útil como «línea» en los mensajes. */
  row: number;
  /** Celdas densas desde la columna A (las vacías con kind `empty`). */
  cells: XlsxCell[];
};

export type ReadXlsxTableOptions = {
  /** Hoja pedida por nombre; por defecto la primera no oculta. */
  sheetName?: string;
  /** Filas NO vacías máximas (cabecera incluida); después `truncated`. */
  maxRows?: number;
  /** Columnas máximas conservadas por fila (las demás se descartan con aviso). */
  maxCols?: number;
  /** Caracteres máximos por celda (se recorta con aviso). */
  maxCellChars?: number;
};

export type XlsxTable = {
  sheetName: string;
  date1904: boolean;
  rows: XlsxRow[];
  warnings: string[];
  truncated: boolean;
};

const EMPTY_CELL: XlsxCell = Object.freeze({ raw: "", kind: "empty", dateStyle: false });

class WarningSink {
  readonly list: string[] = [];
  private dropped = 0;

  push(message: string): void {
    if (this.list.length < XLSX_LITE_MAX_WARNINGS) this.list.push(message);
    else this.dropped += 1;
  }

  finish(): string[] {
    if (this.dropped > 0) this.list.push(`… y ${this.dropped} avisos más de la hoja.`);
    return this.list;
  }
}

function pickSheet(sheets: WorkbookSheet[], sheetName: string | undefined): WorkbookSheet {
  if (sheetName !== undefined && sheetName !== "") {
    const wanted = sheetName.trim().toLowerCase();
    const found = sheets.find((sheet) => sheet.name.trim().toLowerCase() === wanted);
    if (!found) {
      throw new XlsxLiteError("XLSX_NO_SHEET", "La hoja pedida no existe en el libro.", { sheetName, available: sheets.map((sheet) => sheet.name) });
    }
    return found;
  }
  const visible = sheets.find((sheet) => !sheet.hidden);
  if (!visible) throw new XlsxLiteError("XLSX_NO_SHEET", "Todas las hojas del libro están ocultas.");
  return visible;
}

function sheetPartFor(zip: ZipReader, sheet: WorkbookSheet, rels: Map<string, string>): string {
  const candidates: string[] = [];
  if (sheet.relId && rels.has(sheet.relId)) candidates.push(rels.get(sheet.relId)!);
  candidates.push(`xl/worksheets/sheet${sheet.sheetId}.xml`, `xl/worksheets/sheet${sheet.index + 1}.xml`);
  for (const candidate of candidates) {
    if (zip.has(candidate)) return candidate;
  }
  throw new XlsxLiteError("XLSX_NO_SHEET", "No se ha encontrado la parte XML de la hoja.", { sheetName: sheet.name });
}

/**
 * Lee una hoja como tabla: filas no vacías con celdas densas. `maxRows` cuenta filas
 * NO vacías (cabecera incluida) y corta con `truncated = true`; `maxCols` descarta
 * columnas sobrantes con aviso; `maxCellChars` recorta con aviso. Las celdas de
 * error (`t="e"`) y los seriales de fecha imposibles (60 en la época 1900) quedan
 * vacías con `kind = "error"` y aviso; nunca se lanza por una celda.
 */
export function readXlsxTable(buffer: Uint8Array, options: ReadXlsxTableOptions = {}): XlsxTable {
  const maxRows = options.maxRows ?? 5001;
  const maxCols = options.maxCols ?? 200;
  const maxCellChars = options.maxCellChars ?? 2000;
  const zip = new ZipReader(buffer);
  const workbook = readWorkbook(zip);
  const sheet = pickSheet(workbook.sheets, options.sheetName);
  const rels = readWorkbookRels(zip, workbook.part);
  const sheetPart = sheetPartFor(zip, sheet, rels);
  const xml = zip.text(sheetPart);
  if (!xml || !/<(?:[A-Za-z_][\w.-]*:)?worksheet\b/.test(xml)) {
    throw new XlsxLiteError("XLSX_BAD_XML", "La hoja no es un XML de SpreadsheetML válido.", { sheetName: sheet.name });
  }
  const sharedStrings = readSharedStrings(zip);
  const dateStyles = readDateStyles(zip);
  const warnings = new WarningSink();
  const rows: XlsxRow[] = [];
  let truncated = false;
  let colsDroppedWarned = false;
  let unsafeWarned = false;

  const sheetData = SHEETDATA_RE.exec(xml);
  const body = sheetData?.[1] ?? "";
  let lastRow = 0;
  ROW_RE.lastIndex = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = ROW_RE.exec(body)) !== null) {
    const rowAttrs = parseAttrs(rowMatch[1] ?? "");
    const declared = Number.parseInt(rowAttrs.r ?? "", 10);
    const rowNumber = Number.isFinite(declared) && declared > 0 ? declared : lastRow + 1;
    lastRow = rowNumber;
    const inner = rowMatch[2] ?? "";
    if (!inner) continue;

    const cells: XlsxCell[] = [];
    let lastCol = -1;
    let nonEmpty = 0;
    CELL_RE.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = CELL_RE.exec(inner)) !== null) {
      const attrs = parseAttrs(cellMatch[1] ?? "");
      let col: number;
      if (attrs.r) {
        try {
          col = columnIndexFromRef(attrs.r) - 1;
        } catch {
          col = lastCol + 1;
        }
      } else {
        col = lastCol + 1;
      }
      lastCol = col;
      if (col >= maxCols) {
        if (!colsDroppedWarned) {
          warnings.push(`La hoja tiene más de ${maxCols} columnas: las sobrantes se ignoran.`);
          colsDroppedWarned = true;
        }
        continue;
      }
      const styleIndex = Number.parseInt(attrs.s ?? "", 10);
      const dateStyle = Number.isFinite(styleIndex) ? (dateStyles[styleIndex] ?? false) : false;
      const cellInner = cellMatch[2] ?? "";
      const type = attrs.t ?? "n";
      const vMatch = cellInner ? V_RE.exec(cellInner) : null;
      const vText = vMatch ? decodeXmlText(vMatch[1] ?? "").trim() : "";
      let cell: XlsxCell;
      const ref = attrs.r ?? `fila ${rowNumber}, columna ${col + 1}`;

      if (type === "s") {
        const index = Number.parseInt(vText, 10);
        const text = Number.isFinite(index) ? sharedStrings[index] : undefined;
        if (text === undefined) {
          if (vText !== "") warnings.push(`Celda ${ref}: referencia a un texto compartido inexistente; se deja vacía.`);
          cell = EMPTY_CELL;
        } else {
          cell = { raw: text, kind: text === "" ? "empty" : "string", dateStyle };
        }
      } else if (type === "str") {
        cell = { raw: vText, kind: vText === "" ? "empty" : "string", dateStyle };
      } else if (type === "inlineStr") {
        const isMatch = cellInner ? IS_RE.exec(cellInner) : null;
        const text = isMatch ? joinTextRuns(isMatch[1] ?? "") : "";
        cell = { raw: text, kind: text === "" ? "empty" : "string", dateStyle };
      } else if (type === "b") {
        cell = vText === "" ? EMPTY_CELL : { raw: vText === "1" || vText.toLowerCase() === "true" ? "TRUE" : "FALSE", kind: "bool", dateStyle };
      } else if (type === "e") {
        warnings.push(`Celda ${ref}: contiene un error de fórmula de Excel; se deja vacía.`);
        cell = { raw: "", kind: "error", dateStyle };
      } else if (type === "d") {
        const iso = /^(\d{4}-\d{2}-\d{2})/.exec(vText);
        cell = vText === "" ? EMPTY_CELL : { raw: iso ? iso[1]! : vText, kind: iso ? "date" : "string", dateStyle };
      } else {
        // Número (t="n" o sin t): texto crudo conservado; exponente expandido con BigInt.
        if (vText === "") {
          if (cellInner && /<(?:[A-Za-z_][\w.-]*:)?f\b/.test(cellInner)) {
            warnings.push(`Celda ${ref}: fórmula sin valor calculado; se deja vacía.`);
          }
          cell = EMPTY_CELL;
        } else {
          const expanded = expandScientific(vText);
          if (expanded.unsafe && !unsafeWarned) {
            warnings.push(`Celda ${ref}: número entero mayor que 2^53; se conserva como texto.`);
            unsafeWarned = true;
          }
          cell = { raw: expanded.text, kind: "number", dateStyle };
          if (dateStyle) {
            const value = Number(expanded.text);
            if (Number.isFinite(value)) {
              try {
                if (Number.isInteger(value) && value >= 1) {
                  cell = { raw: excelSerialToIso(value, workbook.date1904), kind: "date", dateStyle };
                } else if (value > 0 && value < 1) {
                  cell = { raw: excelFractionToTime(value), kind: "time", dateStyle };
                } else if (value > 1) {
                  cell = { raw: excelSerialToIso(Math.floor(value), workbook.date1904), kind: "date", dateStyle };
                }
              } catch (error) {
                const message = error instanceof XlsxLiteError ? error.message : "serial de fecha no válido";
                warnings.push(`Celda ${ref}: ${message} Se deja vacía.`);
                cell = { raw: "", kind: "error", dateStyle };
              }
            }
          }
        }
      }

      if (cell.raw.length > maxCellChars) {
        warnings.push(`Celda ${ref}: recortada a ${maxCellChars} caracteres.`);
        cell = { raw: cell.raw.slice(0, maxCellChars), kind: cell.kind, dateStyle: cell.dateStyle };
      }
      while (cells.length < col) cells.push(EMPTY_CELL);
      cells[col] = cell;
      if (cell.kind !== "empty" && cell.raw !== "") nonEmpty += 1;
    }
    if (nonEmpty === 0) continue;
    while (cells.length > 0 && cells[cells.length - 1]!.kind === "empty") cells.pop();
    if (rows.length >= maxRows) {
      truncated = true;
      warnings.push(`La hoja supera las ${maxRows} filas con datos: se ha cortado.`);
      break;
    }
    rows.push({ row: rowNumber, cells });
  }

  return { sheetName: sheet.name, date1904: workbook.date1904, rows, warnings: warnings.finish(), truncated };
}
