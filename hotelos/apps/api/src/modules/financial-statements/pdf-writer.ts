// Minimal PDF 1.4 writer for the financial statements (Finanzas · lote
// usali-cuentas). No PDF library exists in node_modules (pdfkit / pdf-lib /
// pdfmake are NOT installed, transitively or otherwise — `ls node_modules/.pnpm`
// finds none), and the rules forbid adding packages that are not already
// there, so the statements are emitted with this writer: standard-14 fonts
// (Helvetica / Helvetica-Bold, WinAnsiEncoding so Spanish accents render),
// text and rules only, uncompressed content streams, a correct xref table.
// Output is a real PDF any viewer opens; it is deliberately plain (tables of
// text), not a designed report.
//
// Alignment of right-justified amounts uses the AFM widths of the standard
// fonts below (digits, comma, dot and minus are exact; accented letters use
// the base glyph width, which only affects left-aligned text truncation).

import { BRAND } from "../../lib/brand.js";

export type PdfFont = "regular" | "bold";

type Run = { x: number; y: number; text: string; font: PdfFont; size: number };
type Rule = { x1: number; y1: number; x2: number; y2: number; width: number };
type Page = { runs: Run[]; rules: Rule[] };

export const A4 = { width: 595.28, height: 841.89 } as const;

// Helvetica widths (AFM, per 1000 em) for WinAnsi 32..126.
const HELVETICA: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584,
  584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667,
  611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500,
  722, 500, 500, 500, 334, 260, 334, 584
];
// Helvetica-Bold widths (AFM) for WinAnsi 32..126.
const HELVETICA_BOLD: number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584,
  584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667,
  611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556,
  778, 556, 556, 500, 389, 280, 389, 584
];

/** Accented / special characters measured as their base glyph. */
const BASE_GLYPH: Record<string, string> = {
  á: "a", à: "a", ä: "a", â: "a", ã: "a", é: "e", è: "e", ë: "e", ê: "e", í: "i", ì: "i", ï: "i", î: "i", ó: "o", ò: "o", ö: "o", ô: "o", õ: "o",
  ú: "u", ù: "u", ü: "u", û: "u", ñ: "n", ç: "c", ý: "y", ÿ: "y",
  Á: "A", À: "A", Ä: "A", Â: "A", Ã: "A", É: "E", È: "E", Ë: "E", Ê: "E", Í: "I", Ì: "I", Ï: "I", Î: "I", Ó: "O", Ò: "O", Ö: "O", Ô: "O", Õ: "O",
  Ú: "U", Ù: "U", Ü: "U", Û: "U", Ñ: "N", Ç: "C", "€": "0", "º": "o", "ª": "a", "¿": "?", "¡": "!", "–": "-", "—": "-", "…": ".", "·": ".",
  "«": "(", "»": ")", "‘": "'", "’": "'", "“": "\"", "”": "\""
};

// Unicode → WinAnsi (cp1252) byte for the characters outside Latin-1.
const CP1252_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f
};

export function pdfTextWidth(text: string, font: PdfFont, size: number): number {
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const ch of text) {
    const base = BASE_GLYPH[ch] ?? ch;
    const code = base.charCodeAt(0);
    const width = code >= 32 && code <= 126 ? table[code - 32]! : 556;
    total += width;
  }
  return (total * size) / 1000;
}

/** Cuts `text` with an ellipsis so it fits `maxWidth` points. */
export function pdfFit(text: string, font: PdfFont, size: number, maxWidth: number): string {
  if (pdfTextWidth(text, font, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && pdfTextWidth(`${out}…`, font, size) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

function encodeWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code >= 0xa0 && code <= 0xff) bytes.push(code);
    else if (CP1252_EXTRA[ch] !== undefined) bytes.push(CP1252_EXTRA[ch]!);
    else bytes.push(0x3f); // '?'
  }
  return bytes;
}

function pdfStringLiteral(text: string): string {
  let out = "(";
  for (const byte of encodeWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

const num = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

export class PdfDocument {
  private readonly pages: Page[] = [];
  readonly width: number;
  readonly height: number;
  private readonly metadata: { title: string; author: string };

  constructor(options: { title: string; author?: string; landscape?: boolean }) {
    this.width = options.landscape ? A4.height : A4.width;
    this.height = options.landscape ? A4.width : A4.height;
    this.metadata = { title: options.title, author: options.author ?? BRAND.name };
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): number {
    this.pages.push({ runs: [], rules: [] });
    return this.pages.length - 1;
  }

  text(page: number, x: number, y: number, text: string, font: PdfFont = "regular", size = 9): void {
    if (!text) return;
    this.pages[page]!.runs.push({ x, y, text, font, size });
  }

  textRight(page: number, xRight: number, y: number, text: string, font: PdfFont = "regular", size = 9): void {
    if (!text) return;
    this.text(page, xRight - pdfTextWidth(text, font, size), y, text, font, size);
  }

  textCenter(page: number, xCenter: number, y: number, text: string, font: PdfFont = "regular", size = 9): void {
    this.text(page, xCenter - pdfTextWidth(text, font, size) / 2, y, text, font, size);
  }

  rule(page: number, x1: number, y1: number, x2: number, y2: number, width = 0.5): void {
    this.pages[page]!.rules.push({ x1, y1, x2, y2, width });
  }

  /** Serialises the document. Offsets are byte offsets, so everything is assembled as Buffers. */
  toBuffer(): Buffer {
    if (this.pages.length === 0) this.addPage();
    const objects: Buffer[] = [];
    const add = (body: string | Buffer): number => {
      objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
      return objects.length; // 1-based object number
    };

    const catalogId = add(""); // placeholder, filled below
    const pagesId = add("");
    const fontRegularId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const fontBoldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const infoId = add(
      `<< /Title ${pdfStringLiteral(this.metadata.title)} /Author ${pdfStringLiteral(this.metadata.author)} /Producer (${BRAND.name} financial-statements) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z) >>`
    );

    const pageIds: number[] = [];
    for (const page of this.pages) {
      const parts: string[] = [];
      for (const rule of page.rules) {
        parts.push(`${num(rule.width)} w ${num(rule.x1)} ${num(rule.y1)} m ${num(rule.x2)} ${num(rule.y2)} l S`);
      }
      for (const run of page.runs) {
        const font = run.font === "bold" ? "/F2" : "/F1";
        parts.push(`BT ${font} ${num(run.size)} Tf 1 0 0 1 ${num(run.x)} ${num(run.y)} Tm ${pdfStringLiteral(run.text)} Tj ET`);
      }
      const content = Buffer.from(parts.join("\n"), "latin1");
      const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]));
      const pageId = add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
          `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`
      );
      pageIds.push(pageId);
    }

    objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
    objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`, "latin1");

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0]!.length;
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(offset);
      const head = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
      const tail = Buffer.from("\nendobj\n", "latin1");
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    const xrefOffset = offset;
    const xref = [`xref`, `0 ${objects.length + 1}`, "0000000000 65535 f "];
    for (const position of offsets) xref.push(`${String(position).padStart(10, "0")} 00000 n `);
    xref.push("trailer", `<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>`, "startxref", String(xrefOffset), "%%EOF", "");
    chunks.push(Buffer.from(xref.join("\n"), "latin1"));
    return Buffer.concat(chunks);
  }
}

// ---------------------------------------------------------------------------
// Table layout on top of the primitive writer
// ---------------------------------------------------------------------------

export type PdfColumn = { label: string; width: number; align: "left" | "right" };
export type PdfRow = { cells: string[]; style?: "normal" | "header" | "total" | "section" | "sub"; indent?: number };
export type PdfTable = { title: string; columns: PdfColumn[]; rows: PdfRow[] };

export type PdfReportOptions = {
  title: string;
  subtitle?: string;
  entity?: string;
  footer?: string;
  landscape?: boolean;
};

/** Renders titled tables one after another, paginating and repeating the column header on each new page. */
export function renderPdfReport(tables: PdfTable[], options: PdfReportOptions): Buffer {
  const doc = new PdfDocument({ title: options.title, landscape: options.landscape });
  const margin = 40;
  const lineHeight = 12;
  const bottom = margin + 24;
  let page = -1;
  let y = 0;

  const newPage = (): void => {
    page = doc.addPage();
    y = doc.height - margin;
    doc.text(page, margin, y, options.title, "bold", 13);
    y -= 15;
    if (options.subtitle) {
      doc.text(page, margin, y, options.subtitle, "regular", 9);
      y -= 12;
    }
    if (options.entity) {
      doc.text(page, margin, y, options.entity, "regular", 9);
      y -= 12;
    }
    doc.rule(page, margin, y, doc.width - margin, y, 0.8);
    y -= 14;
    const footer = `${options.footer ?? `Generado por ${BRAND.name}`} · página ${page + 1}`;
    doc.text(page, margin, margin - 12, footer, "regular", 7);
  };

  const ensure = (needed: number, table: PdfTable): void => {
    if (page < 0 || y - needed < bottom) {
      newPage();
      drawHeader(table);
    }
  };

  const drawHeader = (table: PdfTable): void => {
    let x = margin;
    for (const column of table.columns) {
      const label = pdfFit(column.label, "bold", 8, column.width - 4);
      if (column.align === "right") doc.textRight(page, x + column.width - 2, y, label, "bold", 8);
      else doc.text(page, x + 2, y, label, "bold", 8);
      x += column.width;
    }
    doc.rule(page, margin, y - 3, margin + table.columns.reduce((s, c) => s + c.width, 0), y - 3, 0.5);
    y -= lineHeight + 2;
  };

  newPage();
  for (const table of tables) {
    if (y - lineHeight * 3 < bottom) newPage();
    doc.text(page, margin, y, table.title, "bold", 10);
    y -= lineHeight + 4;
    drawHeader(table);
    for (const row of table.rows) {
      ensure(lineHeight, table);
      const style = row.style ?? "normal";
      const font: PdfFont = style === "total" || style === "header" || style === "section" ? "bold" : "regular";
      const size = style === "sub" ? 7.5 : 8.5;
      if (style === "total") {
        doc.rule(page, margin, y + 9, margin + table.columns.reduce((s, c) => s + c.width, 0), y + 9, 0.4);
      }
      let x = margin;
      row.cells.forEach((cell, index) => {
        const column = table.columns[index];
        if (!column) return;
        const indent = index === 0 ? (row.indent ?? 0) * 10 : 0;
        const text = pdfFit(cell ?? "", font, size, column.width - 4 - indent);
        if (column.align === "right") doc.textRight(page, x + column.width - 2, y, text, font, size);
        else doc.text(page, x + 2 + indent, y, text, font, size);
        x += column.width;
      });
      y -= lineHeight;
    }
    y -= lineHeight;
  }
  return doc.toBuffer();
}
