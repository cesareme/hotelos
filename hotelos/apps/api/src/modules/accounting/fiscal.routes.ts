// Finanzas · lote «iva-modelos» — HTTP surface of the VAT books and AEAT models.
//
// Registered from server.ts with `registerFiscalRoutes(app, { ledger })` (the
// integrator passes the ledger lot's engine; without it the settlement uses
// the interim Prisma engine of vat-settlement.service.ts). Permissions:
// fiscal-route-permissions.partial.ts (spread into routePermissionManifest).
//
// Routes (all organisation-scoped through request.userContext; `propertyId`
// in the query is validated by the global tenant hook):
//   GET  /fiscal/vat-settings                 · PUT /fiscal/vat-settings
//   GET  /fiscal/regime?year=                  (Tanda 6b · R8: régimen de la sociedad y propuesta al cierre)
//   GET  /fiscal/vat-books?book=&period=|from=&to=[&propertyId=]
//   GET  /fiscal/vat-books/periods             (FIX-1 · F3: periods with materialised rows + `latest`)
//   POST /fiscal/vat-books/rebuild            { period | from,to [, propertyId] }
//   POST /fiscal/vat-books/reclassify         { period | from,to [, apply=false, includeZeroRate=false] }  (FIX-1 · F2)
//   GET  /fiscal/models/:modelo?period=|year=  (303 · 390 · 347 · 111 · 115 · 180; 303: `&informativo=1` monthly view of a quarterly sociedad)
//   GET  /fiscal/models/:modelo/pdf            (same query; application/pdf)
//   GET  /fiscal/vat-settlement?period=        (preview of the entry)
//   POST /fiscal/vat-settlement                { period [, entryDate] }
//   POST /fiscal/vat-settlement/reverse        { period [, reason, entryDate] }
// Queries and bodies are zod-strict; every 4xx is Spanish with details.code.
//
// PDF. No PDF library exists in node_modules (pdfkit / pdf-lib / pdfmake are
// NOT installed, whatever the lot brief assumed) and the dependency rule
// forbids adding one, so `renderFiscalReportPdf` below writes a minimal,
// text-only PDF 1.4 by hand: standard Helvetica / Helvetica-Bold (Type1, no
// embedding), WinAnsi encoding (accents and € render), A4, automatic page
// breaks, xref table. It is a summary sheet per box — the same JSON the model
// returns — meant to be keyed into the AEAT sede or handed to the gestoría.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { FiscalModelReport } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { pageHeaders, parsePageQuery } from "../../lib/pagination.js";
import { requireYear } from "../../lib/query-dates.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { buildModelo111 } from "./modelo-111.service.js";
import { buildModelo115 } from "./modelo-115.service.js";
import { buildModelo180 } from "./modelo-180.service.js";
import { buildModelo303 } from "./modelo-303.service.js";
import { buildModelo347 } from "./modelo-347.service.js";
import { buildFiscalRegimeReport, buildModelo390 } from "./modelo-390.service.js";
import { VAT_BOOK_PAGE_LIMIT, getVatSettings, listVatBook, listVatBookPeriods, parseFiscalPeriod, rebuildVatBooks, updateVatSettings } from "./vat-books.service.js";
import { reclassifyVatBooks } from "./vat-books-reclassify.service.js";
import { previewVatSettlement, reverseVatSettlement, settleVatPeriod, type LedgerEngine } from "./vat-settlement.service.js";

export type FiscalRouteDeps = {
  /** Ledger lot's posting engine (accounting.service postJournalEntry / reverseJournalEntry). Omitted → interim engine. */
  ledger?: LedgerEngine;
};

// ── Schemas ─────────────────────────────────────────────────────────────────

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato YYYY-MM-DD");

const vatSettingsPatchSchema = z
  .object({
    periodicity: z.enum(["quarterly", "monthly"]).optional(),
    regime: z.enum(["general", "redeme", "recargo"]).optional(),
    prorrataPct: z.number().min(0).max(100).nullable().optional(),
    taxFigure: z.enum(["IVA", "IGIC", "IPSI"]).optional(),
    // FIX-1 · F3 (B-2): saldo inicial a compensar (casilla 110) y periodo desde el que aplica (2025-Q1 · 2025-01).
    openingCompensation: z.number().min(0).optional(),
    openingCompensationPeriod: z.string().max(10).nullable().optional()
  })
  .strict();

// Tanda L2 (L2-05): the book is a keyset page on (date, id) — `limit` ≤ 500
// (default 500: VatBooksScreen sends `book` + `period` and reads `rows`),
// `cursor` opaque; `period` OR `from`+`to` is mandatory (typed 400). The body
// keeps the object the front reads (`rows`, `resumen`, `origen`, `avisos`,
// `periodo`) plus `total` and `nextCursor`; X-Total-Count / X-Next-Cursor go
// in the headers.
const vatBooksQuerySchema = z
  .object({
    book: z.enum(["emitidas", "recibidas", "bienes_inversion"]),
    period: z.string().min(4).max(10).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    propertyId: z.string().min(1).optional(),
    limit: z.string().optional(),
    cursor: z.string().optional()
  })
  .strict();

const rebuildBodySchema = z
  .object({
    period: z.string().min(4).max(10).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    propertyId: z.string().min(1).optional()
  })
  .strict();

// FIX-1 · F2: reclasificación de régimen de las filas sage200 sin régimen (dry-run por defecto).
const reclassifyBodySchema = z
  .object({
    period: z.string().min(4).max(10).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    apply: z.boolean().optional().default(false),
    includeZeroRate: z.boolean().optional().default(false)
  })
  .strict();

const modelQuerySchema = z
  .object({
    period: z.string().min(4).max(10).optional(),
    year: z.string().regex(/^\d{4}$/, "año de cuatro cifras").optional(),
    propertyId: z.string().min(1).optional(),
    fromDate: isoDay.optional(),
    toDate: isoDay.optional(),
    periodType: z.enum(["monthly", "quarterly"]).optional(),
    // FIX-1 · F3 (E-02): 303 only — a month of a quarterly sociedad as an informative view (no compensation, not filable).
    informativo: z.enum(["1", "0"]).optional()
  })
  .strict();

const regimeQuerySchema = z.object({ year: z.string().regex(/^\d{4}$/, "año de cuatro cifras") }).strict();

const settlementQuerySchema = z.object({ period: z.string().min(6).max(8) }).strict();
const settlementBodySchema = z.object({ period: z.string().min(6).max(8), entryDate: isoDay.optional() }).strict();
const reverseBodySchema = z.object({ period: z.string().min(6).max(8), reason: z.string().max(500).optional(), entryDate: isoDay.optional() }).strict();

export const FISCAL_MODEL_ROUTE_CODES = ["303", "390", "347", "111", "115", "180"] as const;
type ModelCode = (typeof FISCAL_MODEL_ROUTE_CODES)[number];

function modelCodeOf(value: string): ModelCode {
  if ((FISCAL_MODEL_ROUTE_CODES as readonly string[]).includes(value)) return value as ModelCode;
  const error = new BadRequestError(`Modelo «${value}» no admitido: usa 303, 390, 347, 111, 115 o 180.`);
  error.details = { code: "UNKNOWN_MODEL", allowed: FISCAL_MODEL_ROUTE_CODES };
  throw error;
}

function yearOf(query: z.output<typeof modelQuerySchema>): number {
  if (query.year) return requireYear(query.year);
  if (query.period && /^\d{4}$/.test(query.period)) return requireYear(query.period);
  const error = new BadRequestError("Los modelos anuales (390 · 347 · 180) necesitan year=AAAA (o period=AAAA).");
  error.details = { code: "INVALID_PERIOD" };
  throw error;
}

/**
 * One entry point for the JSON and PDF routes. The whole-sociedad read scope
 * (Tanda 6b · R11, `assertFinanceReadScope`) is enforced INSIDE every
 * buildModelo* service, so the legacy /accounting/reports/modelo-* handlers of
 * server.ts (which call the services directly) are covered as well.
 */
export async function buildFiscalModel(modelo: string, query: z.output<typeof modelQuerySchema>, context: UserContext): Promise<FiscalModelReport> {
  const code = modelCodeOf(modelo);
  const propertyId = query.propertyId ?? null;
  switch (code) {
    case "303":
      return buildModelo303({ context, propertyId, period: query.period, fromDate: query.fromDate, toDate: query.toDate, periodType: query.periodType, informativo: query.informativo === "1" });
    case "111":
      return buildModelo111({ context, propertyId, period: query.period, fromDate: query.fromDate, toDate: query.toDate, periodType: query.periodType });
    case "115":
      return buildModelo115({ context, propertyId, period: query.period, fromDate: query.fromDate, toDate: query.toDate, periodType: query.periodType });
    case "390":
      return buildModelo390({ context, propertyId, year: yearOf(query) });
    case "347":
      return buildModelo347({ context, propertyId, year: yearOf(query) });
    case "180":
      return buildModelo180({ context, propertyId, year: yearOf(query) });
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

export function registerFiscalRoutes(app: FastifyInstance, deps: FiscalRouteDeps = {}): void {
  const query = (request: FastifyRequest): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
  const body = (request: FastifyRequest): unknown => request.body ?? {};

  app.get("/fiscal/vat-settings", async (request) => getVatSettings(request.userContext.organizationId));

  app.put("/fiscal/vat-settings", async (request) => {
    const patch = parseOr400(vatSettingsPatchSchema, body(request), "body");
    return updateVatSettings({ context: request.userContext, patch, correlationId: createId("corr") });
  });

  app.get("/fiscal/regime", async (request) => {
    const q = parseOr400(regimeQuerySchema, query(request), "query");
    return buildFiscalRegimeReport({ context: request.userContext, year: requireYear(q.year) });
  });

  app.get("/fiscal/vat-books", async (request, reply) => {
    const raw = query(request);
    const q = parseOr400(vatBooksQuerySchema, raw, "query");
    if (!q.period && !(q.from && q.to)) {
      const error = new BadRequestError("Indica period (2026-Q3 · 2026-09 · 2026) o from y to (YYYY-MM-DD).");
      error.details = { code: "VALIDATION_ERROR", issues: [{ path: "period", message: "period o from+to son obligatorios." }] };
      throw error;
    }
    const page = parsePageQuery(raw, { limit: VAT_BOOK_PAGE_LIMIT, max: VAT_BOOK_PAGE_LIMIT });
    const book = await listVatBook({ context: request.userContext, book: q.book, period: q.period, from: q.from, to: q.to, propertyId: q.propertyId ?? null, limit: page.limit, cursor: page.cursor });
    reply.headers(pageHeaders({ items: book.rows, total: book.total, nextCursor: book.nextCursor }));
    return book;
  });

  // FIX-1 · F3 (E-04): the periods with materialised book rows — the default period of the 303 and the books screens.
  app.get("/fiscal/vat-books/periods", async (request) => listVatBookPeriods(request.userContext.organizationId));

  app.post("/fiscal/vat-books/rebuild", async (request) => {
    const b = parseOr400(rebuildBodySchema, body(request), "body");
    let from = b.from;
    let to = b.to;
    if (b.period) {
      const periodo = parseFiscalPeriod(b.period);
      from = periodo.from;
      to = periodo.to;
    }
    if (!from || !to) throw new BadRequestError("Indica period (2026-Q3 · 2026-09 · 2026) o from y to (YYYY-MM-DD).");
    return rebuildVatBooks({ context: request.userContext, from, to, propertyId: b.propertyId ?? null, correlationId: createId("corr") });
  });

  app.post("/fiscal/vat-books/reclassify", async (request) => {
    const b = parseOr400(reclassifyBodySchema, body(request), "body");
    if (!b.period && !(b.from && b.to)) {
      const error = new BadRequestError("Indica period (2025 · 2025-Q3 · 2025-09) o from y to (YYYY-MM-DD).");
      error.details = { code: "VALIDATION_ERROR", issues: [{ path: "period", message: "period o from+to son obligatorios." }] };
      throw error;
    }
    return reclassifyVatBooks({ context: request.userContext, period: b.period, from: b.from, to: b.to, apply: b.apply, includeZeroRate: b.includeZeroRate, correlationId: createId("corr") });
  });

  app.get("/fiscal/models/:modelo", async (request) => {
    const { modelo } = request.params as { modelo: string };
    const q = parseOr400(modelQuerySchema, query(request), "query");
    return buildFiscalModel(modelo, q, request.userContext);
  });

  app.get("/fiscal/models/:modelo/pdf", async (request, reply: FastifyReply) => {
    const { modelo } = request.params as { modelo: string };
    const q = parseOr400(modelQuerySchema, query(request), "query");
    const report = await buildFiscalModel(modelo, q, request.userContext);
    const pdf = renderFiscalReportPdf(report);
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="modelo-${report.modelo}-${report.periodo.code}.pdf"`)
      .header("Content-Length", String(pdf.length))
      .send(pdf);
  });

  app.get("/fiscal/vat-settlement", async (request) => {
    const q = parseOr400(settlementQuerySchema, query(request), "query");
    return previewVatSettlement({ context: request.userContext, period: q.period });
  });

  app.post("/fiscal/vat-settlement", async (request) => {
    const b = parseOr400(settlementBodySchema, body(request), "body");
    return settleVatPeriod({ context: request.userContext, period: b.period, entryDate: b.entryDate, correlationId: createId("corr") }, { ledger: deps.ledger });
  });

  app.post("/fiscal/vat-settlement/reverse", async (request) => {
    const b = parseOr400(reverseBodySchema, body(request), "body");
    return reverseVatSettlement({ context: request.userContext, period: b.period, reason: b.reason, entryDate: b.entryDate, correlationId: createId("corr") }, { ledger: deps.ledger });
  });
}

// ── Minimal PDF writer (text-only, Helvetica, WinAnsi) ──────────────────────

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - 2 * MARGIN;

/** Unicode → WinAnsi code points above 0x7F that differ from Latin-1. */
const WINANSI_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f
};

/** Map a JS string to a latin1 string of WinAnsi bytes (unknown glyphs → "?") and escape it for a PDF literal. */
export function pdfLiteral(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    let byte: number;
    if (code < 0x80) byte = code;
    else if (WINANSI_EXTRA[char] !== undefined) byte = WINANSI_EXTRA[char]!;
    else if (code >= 0xa0 && code <= 0xff) byte = code;
    else byte = 0x3f; // "?"
    if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x28) out += "\\(";
    else if (byte === 0x29) out += "\\)";
    else if (byte === 0x0a || byte === 0x0d || byte === 0x09) out += " ";
    else if (byte < 0x20) out += "?";
    else out += String.fromCharCode(byte);
  }
  return out;
}

function num(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "") || "0";
}

/** Rough Helvetica width (pt) of a string at `size` (average glyph 0.52 em, digits 0.556 em). */
function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += /[0-9.,]/.test(char) ? 0.556 : /[A-Z]/.test(char) ? 0.68 : /[ilj.,:;' ]/.test(char) ? 0.28 : 0.52;
  return width * size;
}

function truncate(text: string, size: number, maxWidth: number): string {
  if (textWidth(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && textWidth(`${out}…`, size) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

function wrap(text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = truncate(word, size, maxWidth);
    }
  }
  if (current) lines.push(current);
  return lines;
}

const eurFormatter = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatEur(value: number): string {
  return `${eurFormatter.format(value)} €`;
}

class PdfSheet {
  readonly pages: string[][] = [];
  y = PAGE_H - MARGIN;

  constructor() {
    this.newPage();
  }

  private get ops(): string[] {
    return this.pages[this.pages.length - 1]!;
  }

  newPage(): void {
    this.pages.push([]);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  text(x: number, y: number, value: string, size: number, bold = false): void {
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${num(size)} Tf ${num(x)} ${num(y)} Td (${pdfLiteral(value)}) Tj ET`);
  }

  textRight(right: number, y: number, value: string, size: number, bold = false): void {
    this.text(right - textWidth(value, size), y, value, size, bold);
  }

  rule(y: number, x1 = MARGIN, x2 = PAGE_W - MARGIN): void {
    this.ops.push(`0.6 w ${num(x1)} ${num(y)} m ${num(x2)} ${num(y)} l S`);
  }

  line(value: string, size: number, bold = false, indent = 0): void {
    const height = size * 1.45;
    this.ensure(height);
    this.y -= height;
    this.text(MARGIN + indent, this.y, truncate(value, size, CONTENT_W - indent), size, bold);
  }

  paragraph(value: string, size: number, indent = 0): void {
    for (const piece of wrap(value, size, CONTENT_W - indent)) this.line(piece, size, false, indent);
  }

  gap(height: number): void {
    this.ensure(height);
    this.y -= height;
  }

  /** Text-only PDF bytes (latin1: every char is one byte). */
  toBuffer(): Buffer {
    const objects: string[] = [];
    const kids = this.pages.map((_, index) => `${5 + index * 2} 0 R`).join(" ");
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    for (const [index, ops] of this.pages.entries()) {
      const contents = ops.join("\n");
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`);
      objects.push(`<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`);
    }
    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
      offsets.push(out.length);
      out += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

function boxValue(box: FiscalModelReport["casillas"][number]): string {
  if (box.tipo === "tipo") return `${num(box.importe)} %`;
  if (box.tipo === "contador") return String(Math.round(box.importe));
  return formatEur(box.importe);
}

function cellValue(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  return typeof value === "number" ? (Number.isInteger(value) ? String(value) : formatEur(value)) : value;
}

/** Summary sheet of a model: header, boxes by section, totals, warnings, detail table. */
export function renderFiscalReportPdf(report: FiscalModelReport): Buffer {
  const sheet = new PdfSheet();
  sheet.line(report.titulo, 13, true);
  sheet.gap(4);
  sheet.line(`Declarante: ${report.declarante.nif ?? "NIF sin configurar"} · ${report.declarante.nombre ?? "—"}`, 9);
  const regimen = report.sociedad.regimen;
  const regimenLabel = regimen.siiEnabled ? "gran empresa · SII" : regimen.largeCompany ? "gran empresa" : "general";
  sheet.line(`Sociedad: ${report.sociedad.code ? `${report.sociedad.code} · ` : ""}${report.sociedad.legalName}${report.sociedad.source === "organization_fallback" ? " (pendiente de alta)" : ""} · régimen ${regimenLabel} · ${regimen.periodicity === "monthly" ? "mensual" : "trimestral"}`, 9);
  const periodo = report.periodo.type === "annual" ? `Ejercicio ${report.periodo.year}` : `Periodo ${report.periodo.code} (${report.periodo.from} a ${report.periodo.to}) · AEAT ${report.periodo.aeatPeriod}/${report.periodo.year}`;
  sheet.line(periodo, 9);
  if (report.presentacion.noSePresenta) sheet.line(`NO SE PRESENTA: ${report.presentacion.noSePresenta.motivo}`, 9, true);
  if (report.propertyId) sheet.line(`Establecimiento: ${report.propertyId} (vista parcial, no liquidable)`, 9);
  sheet.line(`Generado: ${report.generatedAt.replace("T", " ").slice(0, 19)} UTC · Fuente: ${report.fuentes.origen}`, 8);
  sheet.line(`Presentación: ${report.presentacion.modo} — ${report.presentacion.nota}`, 8);
  sheet.gap(6);
  sheet.rule(sheet.y);

  let section = "";
  for (const box of report.casillas) {
    if (box.seccion !== section) {
      section = box.seccion;
      sheet.gap(8);
      sheet.line(section, 9.5, true);
      sheet.ensure(12);
      sheet.y -= 11;
      sheet.text(MARGIN, sheet.y, "Casilla", 7.5, true);
      sheet.text(MARGIN + 48, sheet.y, "Concepto", 7.5, true);
      sheet.textRight(PAGE_W - MARGIN, sheet.y, "Importe", 7.5, true);
      sheet.rule(sheet.y - 3);
    }
    sheet.ensure(12);
    sheet.y -= 11.5;
    sheet.text(MARGIN, sheet.y, box.casilla ?? "—", 8, Boolean(box.casilla));
    sheet.text(MARGIN + 48, sheet.y, truncate(box.descripcion, 8, CONTENT_W - 150), 8);
    sheet.textRight(PAGE_W - MARGIN, sheet.y, boxValue(box), 8, box.tipo === "resultado");
  }

  sheet.gap(10);
  sheet.line("Totales", 9.5, true);
  for (const [key, value] of Object.entries(report.totales)) {
    sheet.ensure(12);
    sheet.y -= 11.5;
    sheet.text(MARGIN, sheet.y, key, 8);
    sheet.textRight(PAGE_W - MARGIN, sheet.y, Number.isInteger(value) && !/importe|base|cuota|resultado|compensacion|volumen|aIngresar|aCompensar/i.test(key) ? String(value) : formatEur(value), 8);
  }

  if (report.detalle.length > 0) {
    sheet.gap(10);
    sheet.line("Detalle", 9.5, true);
    const keys = Object.keys(report.detalle[0]!);
    const columnWidth = CONTENT_W / keys.length;
    const size = keys.length > 6 ? 6.5 : 7.5;
    sheet.ensure(12);
    sheet.y -= 11;
    keys.forEach((key, index) => sheet.text(MARGIN + index * columnWidth, sheet.y, truncate(key, size, columnWidth - 4), size, true));
    sheet.rule(sheet.y - 3);
    for (const row of report.detalle) {
      sheet.ensure(12);
      sheet.y -= 10.5;
      keys.forEach((key, index) => {
        const value = row[key] ?? null;
        const text = truncate(cellValue(value), size, columnWidth - 4);
        if (typeof value === "number") sheet.textRight(MARGIN + (index + 1) * columnWidth - 4, sheet.y, text, size);
        else sheet.text(MARGIN + index * columnWidth, sheet.y, text, size);
      });
    }
  }

  sheet.gap(10);
  sheet.line(report.avisos.length > 0 ? `Avisos (${report.avisos.length})` : "Avisos: ninguno", 9.5, true);
  for (const aviso of report.avisos) sheet.paragraph(`• ${aviso}`, 7.5, 6);

  return sheet.toBuffer();
}
