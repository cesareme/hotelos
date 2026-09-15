// Minimal PDF 1.4 writer (text, lines, rectangles, standard Type1 fonts with
// WinAnsi encoding) used to render invoices. Written by hand because no PDF
// library (pdfkit / pdf-lib / pdfmake) is present in node_modules/.pnpm of
// this workspace and the lote may not add packages that are not already in
// the store. Pure: builds a Buffer, no I/O.
//
// Coordinates given to the page API are measured from the TOP-left corner in
// points (1 pt = 1/72 in); they are converted to PDF's bottom-left origin at
// render time. A4 = 595.28 × 841.89 pt.

export const A4 = { width: 595.28, height: 841.89 } as const;

export type PdfFont = "regular" | "bold";

type Op = string;

// Helvetica / Helvetica-Bold advance widths (AFM, 1/1000 em) for ASCII 32-126;
// accented letters reuse their base letter, everything else falls back to 556.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

const BASE_LETTER: Record<string, string> = {
  á: "a", à: "a", ä: "a", â: "a", ã: "a", é: "e", è: "e", ë: "e", ê: "e", í: "i", ì: "i", ï: "i", î: "i", ó: "o", ò: "o", ö: "o", ô: "o", õ: "o",
  ú: "u", ù: "u", ü: "u", û: "u", ñ: "n", ç: "c", Á: "A", À: "A", Ä: "A", Â: "A", É: "E", È: "E", Ë: "E", Í: "I", Ï: "I", Ó: "O", Ò: "O", Ö: "O",
  Ú: "U", Ù: "U", Ü: "U", Ñ: "N", Ç: "C"
};

/** Width of `text` in points at `size` for the given font (approximate for non-ASCII). Pure. */
export function textWidth(text: string, size: number, font: PdfFont = "regular"): number {
  const table = font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let width = 0;
  for (const raw of text) {
    const ch = BASE_LETTER[raw] ?? raw;
    const code = ch.charCodeAt(0);
    width += code >= 32 && code <= 126 ? table[code - 32]! : 556;
  }
  return (width * size) / 1000;
}

// Characters outside Latin-1 that WinAnsi (cp1252) does encode in 0x80-0x9F.
const CP1252_EXTRA: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };

/** Encode a JS string as WinAnsi bytes, escaped for a PDF literal string. Pure. */
export function encodePdfString(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    let byte: number;
    if (code === 0x5c || code === 0x28 || code === 0x29) {
      bytes.push(0x5c, code); // \\ \( \)
      continue;
    }
    if (code === 0x0a || code === 0x0d || code === 0x09) byte = 0x20;
    else if (code < 0x80) byte = code;
    else if (CP1252_EXTRA[ch] !== undefined) byte = CP1252_EXTRA[ch]!;
    else if (code >= 0xa0 && code <= 0xff) byte = code;
    else byte = 0x3f; // ?
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export type TextOptions = {
  font?: PdfFont;
  size?: number;
  align?: "left" | "right" | "center";
  /** Grey level 0 (black) – 1 (white). */
  gray?: number;
};

export class PdfPage {
  readonly ops: Op[] = [];
  constructor(
    readonly width: number,
    readonly height: number
  ) {}

  /** Draw `text` with its baseline at `y` from the top. */
  text(x: number, y: number, text: string, options: TextOptions = {}): void {
    const font = options.font ?? "regular";
    const size = options.size ?? 10;
    let startX = x;
    if (options.align === "right") startX = x - textWidth(text, size, font);
    else if (options.align === "center") startX = x - textWidth(text, size, font) / 2;
    const encoded = encodePdfString(text).toString("latin1");
    const gray = options.gray ?? 0;
    this.ops.push(`BT ${num(gray)} g /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${num(startX)} ${num(this.height - y)} Td (${encoded}) Tj ET`);
  }

  /** Word-wrap `text` into lines no wider than `maxWidth`; returns the number of lines drawn. */
  paragraph(x: number, y: number, text: string, maxWidth: number, options: TextOptions & { lineHeight?: number } = {}): number {
    const size = options.size ?? 10;
    const font = options.font ?? "regular";
    const lineHeight = options.lineHeight ?? size * 1.3;
    const lines = wrapText(text, maxWidth, size, font);
    lines.forEach((line, index) => this.text(x, y + index * lineHeight, line, options));
    return lines.length;
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, gray = 0): void {
    this.ops.push(`${num(width)} w ${num(gray)} G ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
  }

  /** Filled (gray) or stroked rectangle with its top-left corner at (x, y). */
  rect(x: number, y: number, w: number, h: number, options: { fill?: boolean; gray?: number; lineWidth?: number } = {}): void {
    const gray = options.gray ?? 0;
    if (options.fill) this.ops.push(`${num(gray)} g ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`);
    else this.ops.push(`${num(options.lineWidth ?? 0.5)} w ${num(gray)} G ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re S`);
  }

  /** Draw a QR module matrix (true = dark) as filled squares; `size` is the total side in points. */
  qr(x: number, y: number, modules: boolean[][], size: number): void {
    const n = modules.length;
    if (n === 0) return;
    const cell = size / n;
    const parts: string[] = ["0 g"];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!modules[r]![c]) continue;
        parts.push(`${(x + c * cell).toFixed(3)} ${(this.height - y - (r + 1) * cell).toFixed(3)} ${cell.toFixed(3)} ${cell.toFixed(3)} re`);
      }
    }
    parts.push("f");
    this.ops.push(parts.join(" "));
  }
}

/** Greedy word wrap using the Helvetica metrics. Pure. */
export function wrapText(text: string, maxWidth: number, size: number, font: PdfFont = "regular"): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size, font) <= maxWidth || !current) current = candidate;
      else {
        out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

export type PdfMetadata = { title?: string; author?: string; subject?: string; producer?: string; creationDate?: Date };

export class PdfDocument {
  private readonly pages: PdfPage[] = [];
  constructor(private readonly metadata: PdfMetadata = {}) {}

  addPage(width = A4.width, height = A4.height): PdfPage {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Serialise the document (PDF 1.4, xref table, binary-safe). */
  render(): Buffer {
    const objects: Buffer[] = [];
    const add = (body: string | Buffer): number => {
      objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
      return objects.length; // 1-based object number
    };
    const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
    const pagesId = add(""); // placeholder, filled after the pages exist
    const fontRegularId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const fontBoldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];
    for (const page of this.pages) {
      const content = Buffer.from(page.ops.join("\n"), "latin1");
      const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "latin1"), content, Buffer.from("\nendstream", "latin1")]));
      const pageId = add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`
      );
      pageIds.push(pageId);
    }
    objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`, "latin1");
    const info = this.metadata;
    const date = info.creationDate ?? new Date();
    const pdfDate = `D:${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
    const infoEntries = [
      info.title ? `/Title (${encodePdfString(info.title).toString("latin1")})` : "",
      info.author ? `/Author (${encodePdfString(info.author).toString("latin1")})` : "",
      info.subject ? `/Subject (${encodePdfString(info.subject).toString("latin1")})` : "",
      `/Producer (${encodePdfString(info.producer ?? "Anfitorio").toString("latin1")})`,
      `/CreationDate (${pdfDate})`
    ].filter(Boolean);
    const infoId = add(`<< ${infoEntries.join(" ")} >>`);

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
    const offsets: number[] = [];
    let position = chunks[0]!.length;
    objects.forEach((body, index) => {
      offsets.push(position);
      const head = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
      const tail = Buffer.from("\nendobj\n", "latin1");
      chunks.push(head, body, tail);
      position += head.length + body.length + tail.length;
    });
    const xrefOffset = position;
    const xref = [`xref`, `0 ${objects.length + 1}`, "0000000000 65535 f "];
    for (const offset of offsets) xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(`${xref.join("\n")}\n${trailer}`, "latin1"));
    return Buffer.concat(chunks);
  }
}
