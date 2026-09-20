// Documents · PDF text-layer extractor without dependencies (Tanda T9 · lote
// T9-03, design §5.1 "Sin proveedor"). Honest fallback when no AI provider is
// configured: reads the text a PDF already carries (native PDFs from an ERP or
// an office suite), never OCR, never images.
//
// Scope: PDF objects (direct and inside object streams), FlateDecode streams
// (node:zlib.inflateSync), page tree (Catalog → Pages → Page, with inherited
// resources; fallback: every /Type /Page object), content operators Tj / TJ /
// ' / " with the positioning operators Td / TD / Tm / T* for line breaks,
// simple fonts in WinAnsi (with /Differences) and composite fonts through their
// /ToUnicode CMap. Unsupported filters (LZW, DCT, JBIG2…) or fonts without a
// usable encoding produce no text for that run; the result says so through
// hasTextLayer = false rather than guessing.
//
// Limits: maxBytes (5 MiB) throws PDF_TEXT_TOO_LARGE; maxPages (200) truncates
// the extraction (pageCount keeps the real count, truncated = true).

import { constants as zlibConstants, inflateSync } from "node:zlib";

export const PDF_TEXT_MAX_BYTES = 5 * 1024 * 1024;
export const PDF_TEXT_MAX_PAGES = 200;

export type PdfTextErrorCode = "PDF_TEXT_TOO_LARGE" | "PDF_TEXT_NOT_PDF";

export class PdfTextError extends Error {
  readonly code: PdfTextErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: PdfTextErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PdfTextError";
    this.code = code;
    if (details) this.details = details;
  }
}

export type PdfTextPage = { pageNo: number; text: string };
export type PdfTextResult = { pages: PdfTextPage[]; pageCount: number; hasTextLayer: boolean; truncated: boolean };
export type PdfTextOptions = { maxBytes?: number; maxPages?: number };

// ---------------------------------------------------------------------------
// Object model
// ---------------------------------------------------------------------------

type PdfObject = { num: number; dict: string; stream: Buffer | null };
type ObjectMap = Map<number, PdfObject>;

const PDF_MAGIC = "%PDF-";

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
}

/** Index just after a balanced `<< … >>` starting at `start` (skips strings); -1 when unbalanced. */
function dictEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "<" && text[i + 1] === "<") {
      depth++;
      i += 2;
      continue;
    }
    if (ch === ">" && text[i + 1] === ">") {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    if (ch === "(") {
      i = literalStringEnd(text, i);
      continue;
    }
    if (ch === "<") {
      const close = text.indexOf(">", i + 1);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (ch === "%") {
      const eol = text.indexOf("\n", i);
      i = eol < 0 ? text.length : eol + 1;
      continue;
    }
    i++;
  }
  return -1;
}

/** Index just after the literal string that opens at `start` (nested parens and escapes honoured). */
function literalStringEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

function directLength(dict: string): number | null {
  const m = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  return m ? Number(m[1]) : null;
}

/** Scans `N G obj … endobj` bodies; streams are sliced by /Length when direct, else up to `endstream`. */
function parseObjects(raw: Buffer, text: string): ObjectMap {
  const objects: ObjectMap = new Map();
  const header = /(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    const num = Number(match[1]);
    let pos = match.index + match[0].length;
    while (pos < text.length && isSpace(text.charCodeAt(pos))) pos++;
    let dict = "";
    let stream: Buffer | null = null;
    let end = pos;
    if (text.startsWith("<<", pos)) {
      const close = dictEnd(text, pos);
      if (close < 0) break;
      dict = text.slice(pos, close);
      end = close;
      let after = close;
      while (after < text.length && isSpace(text.charCodeAt(after))) after++;
      if (text.startsWith("stream", after)) {
        let dataStart = after + "stream".length;
        if (text[dataStart] === "\r") dataStart++;
        if (text[dataStart] === "\n") dataStart++;
        const length = directLength(dict);
        let dataEnd = -1;
        if (length !== null && dataStart + length <= text.length) {
          const probe = text.indexOf("endstream", dataStart + length);
          if (probe >= 0 && probe - (dataStart + length) <= 4) dataEnd = dataStart + length;
        }
        if (dataEnd < 0) {
          const probe = text.indexOf("endstream", dataStart);
          dataEnd = probe < 0 ? text.length : probe;
          while (dataEnd > dataStart && (text[dataEnd - 1] === "\n" || text[dataEnd - 1] === "\r")) dataEnd--;
        }
        stream = raw.subarray(dataStart, dataEnd);
        end = text.indexOf("endstream", dataEnd);
        end = end < 0 ? text.length : end + "endstream".length;
      }
    } else {
      const close = text.indexOf("endobj", pos);
      end = close < 0 ? text.length : close;
      dict = text.slice(pos, end).trim();
    }
    const endobj = text.indexOf("endobj", end);
    header.lastIndex = endobj < 0 ? text.length : endobj + "endobj".length;
    objects.set(num, { num, dict, stream });
  }
  return objects;
}

function filtersOf(dict: string): string[] {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!m) return [];
  return (m[1]!.match(/\/([A-Za-z0-9]+)/g) ?? []).map((f) => f.slice(1));
}

function hasPredictor(dict: string): boolean {
  const m = /\/Predictor\s+(\d+)/.exec(dict);
  return m !== null && Number(m[1]) > 1;
}

/** Decoded stream bytes, or null when a filter is not supported. */
function decodeStream(obj: PdfObject): Buffer | null {
  if (!obj.stream) return null;
  const filters = filtersOf(obj.dict);
  let data: Buffer = obj.stream;
  for (const filter of filters) {
    if (filter === "FlateDecode" || filter === "Fl") {
      if (hasPredictor(obj.dict)) return null;
      try {
        data = inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
      } catch {
        return null;
      }
      continue;
    }
    if (filter === "ASCIIHexDecode" || filter === "AHx") {
      const hex = data.toString("latin1").split(">")[0]!.replace(/[^0-9A-Fa-f]/g, "");
      data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
      continue;
    }
    return null; // LZW, ASCII85, DCT, CCITT, JBIG2, JPX, RunLength: not text
  }
  return data;
}

/** Expands /Type /ObjStm containers into the map (objects that are not already defined directly). */
function expandObjectStreams(objects: ObjectMap): void {
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
    const data = decodeStream(obj);
    if (!data) continue;
    const count = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    if (!count || !first) continue;
    const text = data.toString("latin1");
    const headerTokens = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) {
      const num = headerTokens[i * 2];
      const offset = headerTokens[i * 2 + 1];
      if (num === undefined || offset === undefined || Number.isNaN(num)) continue;
      const start = first + offset;
      const nextOffset = headerTokens[(i + 1) * 2 + 1];
      const end = nextOffset !== undefined ? first + nextOffset : text.length;
      const body = text.slice(start, end).trim();
      if (objects.has(num)) continue;
      objects.set(num, { num, dict: body, stream: null });
    }
  }
}

// ---------------------------------------------------------------------------
// Dictionary helpers (string based on purpose: the dictionaries we need are small)
// ---------------------------------------------------------------------------

function refOf(dict: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`).exec(dict);
  return m ? Number(m[1]) : null;
}

/** Value of `/Key` as raw text: an indirect ref, a nested dict, an array, a name or a number. */
function valueOf(dict: string, key: string): string | null {
  const re = new RegExp(`/${key}(?=[\\s/\\[<(])`);
  const m = re.exec(dict);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < dict.length && isSpace(dict.charCodeAt(i))) i++;
  if (dict.startsWith("<<", i)) {
    const end = dictEnd(dict, i);
    return end < 0 ? null : dict.slice(i, end);
  }
  if (dict[i] === "[") {
    let depth = 0;
    let j = i;
    while (j < dict.length) {
      if (dict[j] === "[") depth++;
      else if (dict[j] === "]") {
        depth--;
        if (depth === 0) return dict.slice(i, j + 1);
      } else if (dict[j] === "(") {
        j = literalStringEnd(dict, j);
        continue;
      }
      j++;
    }
    return null;
  }
  const rest = dict.slice(i);
  const ref = /^(\d+)\s+\d+\s+R\b/.exec(rest);
  if (ref) return ref[0];
  const token = /^(\/[^\s/\[\]<>(){}]*|[^\s/\[\]<>(){}]+)/.exec(rest);
  return token ? token[0] : null;
}

/** Resolves `N 0 R` to the object's dict text; returns direct values untouched. */
function resolveDict(objects: ObjectMap, value: string | null): string | null {
  if (value === null) return null;
  const ref = /^(\d+)\s+\d+\s+R$/.exec(value.trim());
  if (!ref) return value;
  return objects.get(Number(ref[1]))?.dict ?? null;
}

function resolveObject(objects: ObjectMap, value: string | null): PdfObject | null {
  if (value === null) return null;
  const ref = /^(\d+)\s+\d+\s+R$/.exec(value.trim());
  return ref ? (objects.get(Number(ref[1])) ?? null) : null;
}

function refsInArray(value: string): number[] {
  return [...value.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));
}

// ---------------------------------------------------------------------------
// Page tree
// ---------------------------------------------------------------------------

type PageEntry = { obj: PdfObject; resources: string | null };

function collectPages(objects: ObjectMap, maxPages: number): { pages: PageEntry[]; total: number } {
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
  const rootNum = catalog ? refOf(catalog.dict, "Pages") : null;
  const pages: PageEntry[] = [];
  let total = 0;
  const visited = new Set<number>();

  const walk = (num: number, inherited: string | null, depth: number): void => {
    if (visited.has(num) || depth > 64) return;
    visited.add(num);
    const obj = objects.get(num);
    if (!obj) return;
    const own = valueOf(obj.dict, "Resources");
    const resources = own ?? inherited;
    if (/\/Type\s*\/Pages\b/.test(obj.dict) || (/\/Kids\b/.test(obj.dict) && !/\/Type\s*\/Page\b/.test(obj.dict))) {
      const kids = valueOf(obj.dict, "Kids");
      const kidRefs = kids ? refsInArray(resolveDict(objects, kids) ?? kids) : [];
      for (const kid of kidRefs) walk(kid, resources, depth + 1);
      return;
    }
    if (/\/Type\s*\/Page\b/.test(obj.dict) || /\/Contents\b/.test(obj.dict)) {
      total++;
      if (pages.length < maxPages) pages.push({ obj, resources });
    }
  };

  if (rootNum !== null) walk(rootNum, null, 0);
  if (total === 0) {
    // No usable catalog: every /Type /Page object in object order.
    for (const obj of [...objects.values()].sort((a, b) => a.num - b.num)) {
      if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue;
      total++;
      if (pages.length < maxPages) pages.push({ obj, resources: valueOf(obj.dict, "Resources") });
    }
  }
  return { pages, total };
}

function pageContent(objects: ObjectMap, page: PdfObject): Buffer | null {
  const contents = valueOf(page.dict, "Contents");
  if (!contents) return null;
  const refs = contents.trim().startsWith("[") ? refsInArray(contents) : refsInArray(contents);
  const parts: Buffer[] = [];
  for (const num of refs) {
    const obj = objects.get(num);
    if (!obj) continue;
    if (obj.stream) {
      const decoded = decodeStream(obj);
      if (decoded) parts.push(decoded, Buffer.from("\n"));
      continue;
    }
    // An array object holding the content refs.
    for (const inner of refsInArray(obj.dict)) {
      const innerObj = objects.get(inner);
      const decoded = innerObj ? decodeStream(innerObj) : null;
      if (decoded) parts.push(decoded, Buffer.from("\n"));
    }
  }
  return parts.length ? Buffer.concat(parts) : null;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

type FontDecoder = { bytesPerCode: 1 | 2; map: Map<number, string> | null; winAnsi: boolean };

// WinAnsi (cp1252) code points for 0x80–0x9F; the rest is Latin-1.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178
};

function winAnsiChar(code: number): string {
  if (code < 0x80) return String.fromCharCode(code);
  const high = CP1252_HIGH[code];
  if (high !== undefined) return String.fromCharCode(high);
  return code >= 0xa0 ? String.fromCharCode(code) : "";
}

// Glyph names of /Differences arrays → characters (Adobe Glyph List subset: ASCII + Latin-1 + a few typographic).
const GLYPH_NAMES: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*",
  plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^",
  underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", quoteright: "’", quoteleft: "‘", quotedblleft: "“",
  quotedblright: "”", endash: "–", emdash: "—", bullet: "•", ellipsis: "…", Euro: "€", degree: "°", ordfeminine: "ª",
  ordmasculine: "º", exclamdown: "¡", questiondown: "¿", periodcentered: "·", guillemotleft: "«", guillemotright: "»", section: "§",
  copyright: "©", registered: "®", trademark: "™", aacute: "á", agrave: "à", adieresis: "ä", acircumflex: "â", atilde: "ã", eacute: "é", egrave: "è",
  edieresis: "ë", ecircumflex: "ê", iacute: "í", igrave: "ì", idieresis: "ï", icircumflex: "î", oacute: "ó", ograve: "ò", odieresis: "ö", ocircumflex: "ô", otilde: "õ",
  uacute: "ú", ugrave: "ù", udieresis: "ü", ucircumflex: "û", ntilde: "ñ", ccedilla: "ç", Aacute: "Á", Agrave: "À", Adieresis: "Ä", Eacute: "É", Egrave: "È",
  Edieresis: "Ë", Iacute: "Í", Idieresis: "Ï", Oacute: "Ó", Odieresis: "Ö", Uacute: "Ú", Udieresis: "Ü", Ntilde: "Ñ", Ccedilla: "Ç", germandbls: "ß"
};

for (let code = 0x41; code <= 0x5a; code++) GLYPH_NAMES[String.fromCharCode(code)] = String.fromCharCode(code);
for (let code = 0x61; code <= 0x7a; code++) GLYPH_NAMES[String.fromCharCode(code)] = String.fromCharCode(code);

function glyphChar(name: string): string | null {
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1]!, 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(parseInt(u[1]!, 16));
  return GLYPH_NAMES[name] ?? null;
}

function utf16beToString(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  let out = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  if (clean.length % 4 === 2) out += String.fromCharCode(parseInt(clean.slice(-2), 16));
  return out;
}

/** /ToUnicode CMap (bfchar / bfrange, codespace) → code map and code width. */
function parseToUnicode(data: Buffer): { map: Map<number, string>; bytesPerCode: 1 | 2 } {
  const text = data.toString("latin1");
  const map = new Map<number, string>();
  let bytesPerCode: 1 | 2 = 2;
  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (codespace) {
    const first = /<([0-9A-Fa-f]+)>/.exec(codespace[1]!);
    if (first && first[1]!.length <= 2) bytesPerCode = 1;
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1]!, 16), utf16beToString(pair[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!;
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      if (hi < lo || hi - lo > 65_535) continue;
      if (m[4] !== undefined) {
        const base = utf16beToString(m[4]);
        const last = base.length ? base.charCodeAt(base.length - 1) : 0;
        const prefix = base.slice(0, -1);
        for (let code = lo; code <= hi; code++) map.set(code, base.length ? prefix + String.fromCharCode(last + (code - lo)) : "");
      } else {
        const items = [...m[5]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => utf16beToString(x[1]!));
        for (let code = lo; code <= hi && code - lo < items.length; code++) map.set(code, items[code - lo]!);
      }
    }
  }
  return { map, bytesPerCode };
}

function buildFontDecoder(objects: ObjectMap, fontDict: string): FontDecoder {
  const toUnicode = resolveObject(objects, valueOf(fontDict, "ToUnicode"));
  const composite = /\/Subtype\s*\/Type0\b/.test(fontDict);
  if (toUnicode?.stream) {
    const decoded = decodeStream(toUnicode);
    if (decoded) {
      const parsed = parseToUnicode(decoded);
      return { bytesPerCode: composite ? 2 : parsed.bytesPerCode, map: parsed.map, winAnsi: false };
    }
  }
  if (composite) return { bytesPerCode: 2, map: null, winAnsi: false }; // Identity without ToUnicode: unrecoverable
  const decoder: FontDecoder = { bytesPerCode: 1, map: null, winAnsi: true };
  const encoding = valueOf(fontDict, "Encoding");
  const encodingDict = encoding && !encoding.startsWith("/") ? resolveDict(objects, encoding) : null;
  if (encodingDict) {
    const differences = valueOf(encodingDict, "Differences");
    if (differences) {
      const map = new Map<number, string>();
      let code = 0;
      for (const token of differences.slice(1, -1).match(/\/[^\s/\[\]]+|\d+/g) ?? []) {
        if (token.startsWith("/")) {
          const ch = glyphChar(token.slice(1));
          if (ch !== null) map.set(code, ch);
          code++;
        } else code = Number(token);
      }
      decoder.map = map;
    }
  }
  return decoder;
}

function decodeRun(decoder: FontDecoder | null, bytes: Buffer): string {
  const d = decoder ?? { bytesPerCode: 1, map: null, winAnsi: true };
  let out = "";
  if (d.bytesPerCode === 2) {
    if (!d.map) return "";
    for (let i = 0; i + 1 < bytes.length; i += 2) out += d.map.get((bytes[i]! << 8) | bytes[i + 1]!) ?? "";
    return out;
  }
  for (const code of bytes) {
    // /Differences (or a 1-byte ToUnicode) first, WinAnsi for the rest.
    out += d.map?.get(code) ?? winAnsiChar(code);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content stream interpreter
// ---------------------------------------------------------------------------

type Token = { kind: "num"; value: number } | { kind: "str"; value: Buffer } | { kind: "name"; value: string } | { kind: "arr"; value: Token[] } | { kind: "op"; value: string };

function tokenize(content: Buffer): Token[] {
  const text = content.toString("latin1");
  const tokens: Token[] = [];
  const stack: Token[][] = [tokens];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      i++;
      continue;
    }
    if (ch === "%") {
      const eol = text.indexOf("\n", i);
      i = eol < 0 ? n : eol + 1;
      continue;
    }
    if (ch === "[") {
      const arr: Token[] = [];
      stack[stack.length - 1]!.push({ kind: "arr", value: arr });
      stack.push(arr);
      i++;
      continue;
    }
    if (ch === "]") {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (ch === "(") {
      const end = literalStringEnd(text, i);
      stack[stack.length - 1]!.push({ kind: "str", value: unescapeLiteral(text.slice(i + 1, end - 1)) });
      i = end;
      continue;
    }
    if (ch === "<" && text[i + 1] === "<") {
      const end = dictEnd(text, i);
      i = end < 0 ? n : end;
      continue; // inline dictionaries (marked content, inline images) carry no text
    }
    if (ch === "<") {
      const end = text.indexOf(">", i + 1);
      const hex = (end < 0 ? text.slice(i + 1) : text.slice(i + 1, end)).replace(/[^0-9A-Fa-f]/g, "");
      stack[stack.length - 1]!.push({ kind: "str", value: Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex") });
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      while (j < n && !isSpace(text.charCodeAt(j)) && !"/[]<>(){}%".includes(text[j]!)) j++;
      stack[stack.length - 1]!.push({ kind: "name", value: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === ")" || ch === ">") {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !isSpace(text.charCodeAt(j)) && !"/[]<>(){}%".includes(text[j]!)) j++;
    const word = text.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      stack[stack.length - 1]!.push({ kind: "num", value: Number(word) });
      continue;
    }
    if (word === "BI") {
      // Inline image: skip to EI delimited by whitespace.
      const ei = /\sEI(?=\s|$)/g;
      ei.lastIndex = i;
      const m = ei.exec(text);
      i = m ? m.index + m[0].length : n;
      continue;
    }
    stack[stack.length - 1]!.push({ kind: "op", value: word });
  }
  return tokens;
}

function unescapeLiteral(body: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out.push(body.charCodeAt(i) & 0xff);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i++;
    switch (next) {
      case "n":
        out.push(0x0a);
        break;
      case "r":
        out.push(0x0d);
        break;
      case "t":
        out.push(0x09);
        break;
      case "b":
        out.push(0x08);
        break;
      case "f":
        out.push(0x0c);
        break;
      case "\r":
        if (body[i + 1] === "\n") i++;
        break;
      case "\n":
        break;
      default: {
        if (/[0-7]/.test(next)) {
          let oct = next;
          while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? "")) oct += body[++i];
          out.push(parseInt(oct, 8) & 0xff);
        } else out.push(body.charCodeAt(i) & 0xff);
      }
    }
  }
  return Buffer.from(out);
}

/**
 * Runs the text operators of one page. Line breaks come from the text-line
 * position (Td / TD / Tm / T* / ' / "): a run drawn at a different vertical
 * position than the previous one starts a new line, a run on the same line
 * is separated by a space (no font metrics: adjacent runs on a line are
 * spaced, which is what a label + amount layout needs). Kerning gaps inside a
 * TJ array below −200/1000 em also become a space.
 */
function interpretContent(content: Buffer, fonts: Map<string, FontDecoder>): string {
  const tokens = tokenize(content);
  const operands: Token[] = [];
  let out = "";
  let font: FontDecoder | null = null;
  let leading = 0;
  let lineY = 0;
  let lastDrawY: number | null = null;
  let pendingBreak = false;
  const num = (index: number): number | null => {
    const token = operands[operands.length - index];
    return token?.kind === "num" ? token.value : null;
  };
  const beforeDraw = (): void => {
    if (pendingBreak || (lastDrawY !== null && Math.abs(lineY - lastDrawY) > 0.5)) {
      if (out.length && !out.endsWith("\n")) out += "\n";
    } else if (lastDrawY !== null && out.length && !/\s$/.test(out)) out += " ";
    pendingBreak = false;
    lastDrawY = lineY;
  };
  const draw = (token: Token | undefined): void => {
    if (token?.kind !== "str") return;
    beforeDraw();
    out += decodeRun(font, token.value);
  };
  for (const token of tokens) {
    if (token.kind !== "op") {
      operands.push(token);
      if (operands.length > 32) operands.shift();
      continue;
    }
    switch (token.value) {
      case "BT":
        lineY = 0;
        break;
      case "Tf": {
        const name = operands.find((t) => t.kind === "name");
        font = name ? (fonts.get(name.value) ?? null) : null;
        break;
      }
      case "TL":
        leading = num(1) ?? leading;
        break;
      case "Td":
        lineY += num(1) ?? 0;
        break;
      case "TD":
        leading = -(num(1) ?? 0);
        lineY += num(1) ?? 0;
        break;
      case "Tm":
        lineY = num(1) ?? lineY;
        break;
      case "T*":
        lineY -= leading;
        pendingBreak = true;
        break;
      case "Tj":
        draw(operands[operands.length - 1]);
        break;
      case "'":
        lineY -= leading;
        pendingBreak = true;
        draw(operands[operands.length - 1]);
        break;
      case '"':
        lineY -= leading;
        pendingBreak = true;
        draw(operands[operands.length - 1]);
        break;
      case "TJ": {
        const arr = operands[operands.length - 1];
        if (arr?.kind === "arr") {
          let first = true;
          for (const item of arr.value) {
            if (item.kind === "str") {
              if (first) beforeDraw();
              first = false;
              out += decodeRun(font, item.value);
            } else if (item.kind === "num" && item.value < -200 && out.length && !/\s$/.test(out)) out += " ";
          }
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  return out;
}

function normalizePageText(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function fontsOf(objects: ObjectMap, resources: string | null): Map<string, FontDecoder> {
  const fonts = new Map<string, FontDecoder>();
  const resDict = resolveDict(objects, resources);
  if (!resDict) return fonts;
  const fontDictRaw = resolveDict(objects, valueOf(resDict, "Font"));
  if (!fontDictRaw) return fonts;
  const inner = fontDictRaw.trim().startsWith("<<") ? fontDictRaw.trim().slice(2, -2) : fontDictRaw;
  const re = /\/([^\s/\[\]<>(){}]+)\s*(\d+\s+\d+\s+R|<<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const name = m[1]!;
    let dict: string | null;
    if (m[2] === "<<") {
      const start = m.index + m[0].length - 2;
      const end = dictEnd(inner, start);
      dict = end < 0 ? null : inner.slice(start, end);
      re.lastIndex = end < 0 ? inner.length : end;
    } else dict = resolveDict(objects, m[2]!);
    if (dict) fonts.set(name, buildFontDecoder(objects, dict));
  }
  return fonts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function loadObjects(bytes: Uint8Array): { raw: Buffer; objects: ObjectMap } {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objects = parseObjects(raw, raw.toString("latin1"));
  expandObjectStreams(objects);
  return { raw, objects };
}

export function extractPdfText(bytes: Uint8Array, options: PdfTextOptions = {}): PdfTextResult {
  const maxBytes = options.maxBytes ?? PDF_TEXT_MAX_BYTES;
  const maxPages = options.maxPages ?? PDF_TEXT_MAX_PAGES;
  if (bytes.byteLength > maxBytes) {
    throw new PdfTextError("PDF_TEXT_TOO_LARGE", `El PDF supera el tamaño admitido para extraer texto (${maxBytes} bytes).`, { bytes: bytes.byteLength, max: maxBytes });
  }
  if (!isPdf(bytes)) throw new PdfTextError("PDF_TEXT_NOT_PDF", "El contenido no es un PDF (falta la cabecera %PDF-).");
  const { objects } = loadObjects(bytes);
  const { pages: entries, total } = collectPages(objects, maxPages);
  const pages: PdfTextPage[] = entries.map((entry, index) => {
    const content = pageContent(objects, entry.obj);
    const text = content ? normalizePageText(interpretContent(content, fontsOf(objects, entry.resources))) : "";
    return { pageNo: index + 1, text };
  });
  const hasTextLayer = pages.some((page) => /[\p{L}\p{N}]{2,}/u.test(page.text));
  return { pages, pageCount: total, hasTextLayer, truncated: total > pages.length };
}

/** Page count by /Type /Page objects (direct or in object streams); fallback: the largest /Count of a Pages node. */
export function countPdfPages(bytes: Uint8Array): number {
  if (!isPdf(bytes)) return 0;
  const { objects } = loadObjects(bytes);
  let count = 0;
  let maxCount = 0;
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Page\b/.test(obj.dict)) count++;
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const c = Number(/\/Count\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
      if (c > maxCount) maxCount = c;
    }
  }
  return count > 0 ? count : maxCount;
}
