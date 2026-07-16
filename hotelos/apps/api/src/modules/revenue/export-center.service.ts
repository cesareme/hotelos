// Revenue Export Center (contract frozen 2026-07-15).
//
// Catalog of the 6 operational exports + the generator. Everything is computed
// from the real board service / Prisma (never the demo store) and NOTHING is
// invented: when a source is empty the export is still generated with the
// available rows plus an "Aviso" line in the preamble/sheet.
//
// Formats:
//   csv — es-ES conventions: ';' separator, decimal comma, ISO dates, EUR
//         amounts without symbol, key;value preamble + blank line + header.
//   xls — SpreadsheetML 2003 XML (multi-sheet, hand-built, no dependencies).
//   pdf — printable A4 HTML (@media print); the UI downloads it as .html and
//         labels it "PDF (imprimir)".

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { getHistoryForecastBoard, type BoardRow, type HistoryForecastBoard } from "./hf-board.service.js";
import { getForecastBySegment } from "./forecast.service.js";
import { getMeetingPack } from "./strategy.service.js";
import { getPeriodMetrics } from "./comparison.service.js";

const MS_DAY = 86_400_000;
const CLOSED_STAY_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;

// ---- shared helpers ---------------------------------------------------------
function dayUtc(value?: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const base = value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return new Date(`${base}T00:00:00.000Z`);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function endOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}
function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function dec(v: Prisma.Decimal | number | null | undefined): number {
  return v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
}
function decOrNull(v: Prisma.Decimal | number | null | undefined): number | null {
  return v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** "dd/mm/yyyy HH:MM" in Europe/Madrid (the "Generado"/OTB stamp). */
function madridStamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function slugify(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "hotel";
}

// ---- CSV es-ES helpers --------------------------------------------------------
function csvEsc(v: string): string {
  return /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
/** Decimal comma, fixed decimals, no thousands separator, no € symbol. */
function csvNum(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  return n.toFixed(decimals).replace(".", ",");
}
function csvInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  return String(Math.round(n));
}
function csvLines(preamble: Array<[string, string]>, header: string[], rows: string[][]): string[] {
  return [
    ...preamble.map(([k, v]) => `${csvEsc(k)};${csvEsc(v)}`),
    "",
    header.map(csvEsc).join(";"),
    ...rows.map((r) => r.join(";"))
  ];
}

// ---- SpreadsheetML 2003 (xls) builder ------------------------------------------
export type SheetCell = string | number | Date | null | { v: string | number | Date | null; header?: boolean };
export type SpreadsheetSheet = { name: string; rows: SheetCell[][] };

function xmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Hand-built SpreadsheetML 2003 workbook (opens in Excel/LibreOffice as .xls).
 * No dependencies: cells typed Number/String/DateTime, bold headers, date style.
 */
export function buildSpreadsheetMl(sheets: SpreadsheetSheet[]): string {
  const usedNames = new Set<string>();
  const safeSheetName = (raw: string): string => {
    const base = raw.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28).trim() || "Hoja";
    let candidate = base;
    let i = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${base} ${i++}`;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };
  const cellXml = (cell: SheetCell): string => {
    const obj = cell !== null && typeof cell === "object" && !(cell instanceof Date) ? cell : { v: cell as string | number | Date | null };
    const v = obj.v;
    const style = "header" in obj && obj.header ? ` ss:StyleID="sHeader"` : v instanceof Date ? ` ss:StyleID="sDate"` : "";
    if (v === null || v === undefined) return `<Cell${style}/>`;
    if (v instanceof Date) {
      return `<Cell${style}><Data ss:Type="DateTime">${isoDate(v)}T00:00:00.000</Data></Cell>`;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      return `<Cell${style}><Data ss:Type="Number">${v}</Data></Cell>`;
    }
    return `<Cell${style}><Data ss:Type="String">${xmlEscape(String(v))}</Data></Cell>`;
  };
  const worksheets = sheets
    .map((sheet) => {
      const rows = sheet.rows.map((row) => `<Row>${row.map(cellXml).join("")}</Row>`).join("\n");
      return `<Worksheet ss:Name="${xmlEscape(safeSheetName(sheet.name))}">\n<Table>\n${rows}\n</Table>\n</Worksheet>`;
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<?mso-application progid="Excel.Sheet"?>`,
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"`,
    ` xmlns:o="urn:schemas-microsoft-com:office:office"`,
    ` xmlns:x="urn:schemas-microsoft-com:office:excel"`,
    ` xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`,
    `<Styles>`,
    `<Style ss:ID="sHeader"><Font ss:Bold="1"/><Interior ss:Color="#EFEFEF" ss:Pattern="Solid"/></Style>`,
    `<Style ss:ID="sDate"><NumberFormat ss:Format="Short Date"/></Style>`,
    `</Styles>`,
    worksheets,
    `</Workbook>`
  ].join("\n");
}

// ---- printable A4 HTML ("pdf") ------------------------------------------------
const HTML_STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1d1d1f; margin: 0; padding: 24px; font-size: 12px; }
  header.doc { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1d1d1f; padding-bottom: 8px; margin-bottom: 14px; }
  header.doc h1 { font-size: 18px; margin: 0; }
  header.doc .meta { text-align: right; font-size: 11px; color: #555; }
  h2 { font-size: 13px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th { text-align: left; border-bottom: 1px solid #999; padding: 3px 6px; font-weight: 600; background: #f5f5f7; }
  td { border-bottom: 1px solid #eee; padding: 3px 6px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .kpis { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 10px; }
  .kpi { border: 1px solid #ddd; border-radius: 6px; padding: 6px 10px; min-width: 110px; }
  .kpi .label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.03em; }
  .kpi .value { font-size: 15px; font-weight: 700; margin-top: 2px; }
  .kpi .sub { font-size: 10px; color: #666; }
  .status-ok { color: #1a7f37; font-weight: 600; }
  .status-warn { color: #9a6700; font-weight: 600; }
  .status-risk { color: #c0392b; font-weight: 600; }
  .status-no_budget { color: #666; }
  .aviso { background: #fff8e1; border: 1px solid #e6c200; border-radius: 6px; padding: 6px 10px; margin: 6px 0; font-size: 11px; }
  footer.doc { margin-top: 16px; font-size: 10px; color: #888; border-top: 1px solid #ddd; padding-top: 6px; }
  @page { size: A4; margin: 12mm; }
  @media print { body { padding: 0; } }
`;

function printableHtml(opts: { title: string; hotel: string; stamp: string; range?: string; body: string }): string {
  return [
    `<!doctype html>`,
    `<html lang="es">`,
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${xmlEscape(`${opts.title} — ${opts.hotel}`)}</title>`,
    `<style>${HTML_STYLES}</style></head>`,
    `<body>`,
    `<header class="doc"><div><h1>${xmlEscape(opts.title)}</h1><div>${xmlEscape(opts.hotel)}</div></div>`,
    `<div class="meta">Generado ${xmlEscape(opts.stamp)} (OTB, Europe/Madrid)${opts.range ? `<br>Rango: ${xmlEscape(opts.range)}` : ""}</div></header>`,
    opts.body,
    `<footer class="doc">Anfitorio · Revenue — documento imprimible A4 (usa Imprimir → Guardar como PDF).</footer>`,
    `</body></html>`
  ].join("\n");
}

// User-facing number formats for HTML documents (Spanish locale).
function fmtEur(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}
function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("es-ES");
}
function signed(n: number | null | undefined, fmt: (v: number) => string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmt(n)}`;
}

// ---- catalog (contract §3, exact table) ------------------------------------------
export type ExportFormat = "csv" | "xls" | "pdf";
export type ExportDef = {
  code: string;
  name: string;
  description: string;
  ritual: "diario" | "semanal" | "mensual";
  formats: ExportFormat[];
  params: "dateRange" | "month" | "none";
  recommendedSchedule?: string;
};

const CONVENTIONS = [
  "CSV es-ES: separador ';' y coma decimal",
  "Fechas ISO (YYYY-MM-DD) en los datos",
  "Importes EUR sin símbolo",
  "Cabecera con hora OTB (Europe/Madrid)",
  "Nombre: anfitorio_{hotel}_{informe}_{fecha}"
];

const EXPORT_DEFS: ExportDef[] = [
  {
    code: "hf_daily",
    name: "Informe diario History & Forecast",
    description:
      "Tabla día a día con bloques Actual/OTB, Forecast, STLY, presupuesto y pickup — el informe del repaso matinal.",
    ritual: "diario",
    formats: ["csv", "xls"],
    params: "dateRange",
    recommendedSchedule: "Cada mañana 7:00"
  },
  {
    code: "pickup_daily",
    name: "Pickup diario (Δ 1/7/28)",
    description: "Variación de habitaciones OTB a 1, 7 y 28 días por fecha de estancia futura.",
    ritual: "diario",
    formats: ["csv"],
    params: "dateRange",
    recommendedSchedule: "Cada mañana tras el cierre"
  },
  {
    code: "flash_direccion",
    name: "Flash de dirección (1 página)",
    description:
      "Resumen de una página para dirección: ayer, mes en curso vs presupuesto vs año anterior y próximos 7/30 días.",
    ritual: "diario",
    formats: ["pdf"],
    params: "none",
    recommendedSchedule: "Cada mañana 8:00"
  },
  {
    code: "pace_segmento",
    name: "Pace por segmento",
    description: "Previsión diaria repartida por segmento de mercado: hoja resumen + una hoja por segmento.",
    ritual: "semanal",
    formats: ["xls"],
    params: "dateRange",
    recommendedSchedule: "Lunes"
  },
  {
    code: "meeting_pack",
    name: "Meeting pack de revenue",
    description:
      "Dossier de la reunión semanal: pace y pickup, precisión del forecast, presupuesto, fechas críticas y recomendaciones.",
    ritual: "semanal",
    formats: ["pdf"],
    params: "none",
    recommendedSchedule: "Miércoles (reunión semanal)"
  },
  {
    code: "cierre_mensual",
    name: "Cierre mensual día a día",
    description: "Cierre del mes día a día con resumen vs presupuesto y año anterior y desglose por segmento.",
    ritual: "mensual",
    formats: ["xls", "csv"],
    params: "month",
    recommendedSchedule: "Día 1 del mes"
  }
];

export async function getExportCatalog(propertyId: string) {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return { propertyId, conventions: CONVENTIONS, exports: EXPORT_DEFS };
}

// ---- hf_daily -----------------------------------------------------------------
const HF_HEADER = [
  "Fecha",
  "Día",
  "Hab. vendidas",
  "Ocupación %",
  "ADR",
  "RevPAR",
  "Ingreso hab.",
  "Llegadas",
  "Salidas",
  "No-shows",
  "OOO",
  "Fc hab.",
  "Fc ocupación %",
  "Fc ADR",
  "Fc ingreso",
  "Fc confianza",
  "STLY hab.",
  "STLY ocupación %",
  "STLY ADR",
  "STLY ingreso",
  "Dif hab. vs STLY",
  "Dif ingreso vs STLY",
  "Presupuesto día",
  "Dif vs presupuesto",
  "Pickup 1d",
  "Pickup 7d",
  "Pickup 28d",
  "Dif ADR 7d"
];

function boardWarnings(board: HistoryForecastBoard): Array<[string, string]> {
  const warnings: Array<[string, string]> = [];
  if (board.forecastMissing) warnings.push(["Aviso", "Sin previsión en el rango (genera el forecast en Revenue)"]);
  if (board.budgetMissing) warnings.push(["Aviso", "Sin presupuesto en el rango"]);
  return warnings;
}

function hfCsvRow(r: BoardRow): string[] {
  return [
    r.date ?? "",
    r.dow ?? "",
    csvInt(r.roomsSold),
    csvNum(r.occPct),
    csvNum(r.adr),
    csvNum(r.revpar),
    csvNum(r.roomRevenue),
    csvInt(r.arrivals),
    csvInt(r.departures),
    csvInt(r.noShows),
    csvInt(r.ooo),
    csvInt(r.fcRooms),
    csvNum(r.fcOccPct),
    csvNum(r.fcAdr),
    csvNum(r.fcRevenue),
    csvNum(r.fcConfidence, 0),
    csvInt(r.stlyRooms),
    csvNum(r.stlyOccPct),
    csvNum(r.stlyAdr),
    csvNum(r.stlyRevenue),
    csvInt(r.deltaRoomsVsStly),
    csvNum(r.deltaRevVsStly),
    csvNum(r.budgetRevenue),
    csvNum(r.deltaRevVsBudget),
    csvInt(r.pickup1),
    csvInt(r.pickup7),
    csvInt(r.pickup28),
    csvNum(r.pickupAdr7)
  ];
}

function buildHfDailyCsv(board: HistoryForecastBoard, defName: string): string {
  const preamble: Array<[string, string]> = [
    ["Hotel", board.propertyName],
    ["Informe", defName],
    ["Generado", `${madridStamp()} Europe/Madrid`],
    ["Rango", `${board.from} a ${board.to}`],
    ...boardWarnings(board)
  ];
  const dataRows = board.rows.filter((r) => r.rowType === "data");
  return csvLines(preamble, HF_HEADER, dataRows.map(hfCsvRow)).join("\n");
}

function hfXlsRow(r: BoardRow): SheetCell[] {
  return [
    r.date ? dayUtc(r.date) : (r.label ?? null),
    r.dow ?? null,
    r.roomsSold,
    r.occPct,
    r.adr,
    r.revpar,
    r.roomRevenue,
    r.arrivals,
    r.departures,
    r.noShows,
    r.ooo,
    r.fcRooms,
    r.fcOccPct,
    r.fcAdr,
    r.fcRevenue,
    r.fcConfidence,
    r.stlyRooms,
    r.stlyOccPct,
    r.stlyAdr,
    r.stlyRevenue,
    r.deltaRoomsVsStly,
    r.deltaRevVsStly,
    r.budgetRevenue,
    r.deltaRevVsBudget,
    r.pickup1,
    r.pickup7,
    r.pickup28,
    r.pickupAdr7
  ];
}

function buildHfDailyXls(board: HistoryForecastBoard, defName: string): string {
  const headerRow: SheetCell[] = HF_HEADER.map((h) => ({ v: h, header: true }));
  const mainRows: SheetCell[][] = [
    ["Hotel", board.propertyName],
    ["Informe", defName],
    ["Generado", `${madridStamp()} Europe/Madrid`],
    ["Rango", `${board.from} a ${board.to}`],
    ...boardWarnings(board).map(([k, v]) => [k, v] as SheetCell[]),
    [],
    headerRow,
    ...board.rows.map(hfXlsRow)
  ];
  const dictionary: SheetCell[][] = [
    [{ v: "Diccionario de métricas", header: true }],
    ...board.metricNotes.map((n) => [n] as SheetCell[]),
    [],
    [{ v: "Fuentes de datos", header: true }],
    ...Object.entries(board.sources).map(([k, v]) => [k, v] as SheetCell[])
  ];
  return buildSpreadsheetMl([
    { name: "H&F diario", rows: mainRows },
    { name: "Diccionario", rows: dictionary }
  ]);
}

// ---- pickup_daily ----------------------------------------------------------------
function buildPickupCsv(board: HistoryForecastBoard, defName: string): string {
  const preamble: Array<[string, string]> = [
    ["Hotel", board.propertyName],
    ["Informe", defName],
    ["Generado", `${madridStamp()} Europe/Madrid`],
    ["Rango", `${board.from} a ${board.to}`],
    ...boardWarnings(board)
  ];
  const header = ["Fecha", "Día", "Hab. OTB", "Ingreso OTB", "Pickup 1d", "Pickup 7d", "Pickup 28d", "Fc hab.", "Fc ocupación %"];
  const rows = board.rows
    .filter((r) => r.rowType === "data" && !r.isPast)
    .map((r) => [
      r.date ?? "",
      r.dow ?? "",
      csvInt(r.roomsSold),
      csvNum(r.roomRevenue),
      csvInt(r.pickup1),
      csvInt(r.pickup7),
      csvInt(r.pickup28),
      csvInt(r.fcRooms),
      csvNum(r.fcOccPct)
    ]);
  return csvLines(preamble, header, rows).join("\n");
}

// ---- flash_direccion ---------------------------------------------------------------
function buildFlashHtml(board: HistoryForecastBoard): string {
  const stamp = madridStamp();
  const yesterdayRow = board.rows.find((r) => r.rowType === "data" && r.date === board.businessDate);
  const futureRows = board.rows.filter((r) => r.rowType === "data" && !r.isPast && r.date);
  const fcSum = (days: number): number | null => {
    const cutoff = isoDate(addDays(dayUtc(), days));
    const inRange = futureRows.filter((r) => (r.date as string) < cutoff && r.fcRevenue !== null);
    if (!inRange.length) return null;
    return round2(inRange.reduce((s, r) => s + (r.fcRevenue ?? 0), 0));
  };
  const m0 = board.months[0];
  const kpiCard = (label: string, value: string, sub?: string) =>
    `<div class="kpi"><div class="label">${xmlEscape(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  const statusLabel: Record<string, string> = { ok: "OK", warn: "Atención", risk: "Riesgo", no_budget: "Sin presupuesto" };

  const warnings = boardWarnings(board)
    .map(([, v]) => `<div class="aviso">${xmlEscape(v)}</div>`)
    .join("");

  const yesterdayBlock = yesterdayRow
    ? `<div class="kpis">
        ${kpiCard("Ocupación", fmtPct(yesterdayRow.occPct), yesterdayRow.stlyOccPct !== null ? `STLY ${fmtPct(yesterdayRow.stlyOccPct)}` : undefined)}
        ${kpiCard("Habitaciones", fmtInt(yesterdayRow.roomsSold), yesterdayRow.deltaRoomsVsStly !== null ? `${signed(yesterdayRow.deltaRoomsVsStly, (v) => fmtInt(v))} vs STLY` : undefined)}
        ${kpiCard("ADR", fmtEur(yesterdayRow.adr), yesterdayRow.stlyAdr !== null ? `STLY ${fmtEur(yesterdayRow.stlyAdr)}` : undefined)}
        ${kpiCard("RevPAR", fmtEur(yesterdayRow.revpar))}
        ${kpiCard("Ingreso habitaciones", fmtEur(yesterdayRow.roomRevenue), yesterdayRow.deltaRevVsStly !== null ? `${signed(yesterdayRow.deltaRevVsStly, (v) => fmtEur(v))} vs STLY` : undefined)}
      </div>`
    : `<div class="aviso">Sin datos de ayer (${xmlEscape(board.businessDate)}) en el rango.</div>`;

  const mtdBlock = `<div class="kpis">
      ${kpiCard("Habitaciones MTD", fmtInt(board.kpis.mtd.roomsSold))}
      ${kpiCard("Ocupación MTD", fmtPct(board.kpis.mtd.occPct))}
      ${kpiCard("ADR MTD", fmtEur(board.kpis.mtd.adr))}
      ${kpiCard("Ingresos MTD", fmtEur(board.kpis.mtd.revenue), board.kpis.mtd.vsStlyRevenuePct !== null ? `${signed(board.kpis.mtd.vsStlyRevenuePct, (v) => fmtPct(v))} vs STLY` : undefined)}
    </div>
    ${
      m0
        ? `<table><thead><tr><th>Mes</th><th class="num">Proyección</th><th class="num">Presupuesto</th><th class="num">Gap</th><th>Estado</th><th class="num">Cierre LY</th></tr></thead>
      <tbody><tr><td>${xmlEscape(m0.label)}</td><td class="num">${fmtEur(m0.projectedRevenue)}</td><td class="num">${fmtEur(m0.budgetRevenue)}</td><td class="num">${m0.gapToBudget !== null ? signed(m0.gapToBudget, (v) => fmtEur(v)) : "—"}${m0.gapPct !== null ? ` (${signed(m0.gapPct, (v) => fmtPct(v))})` : ""}</td><td class="status-${m0.status}">${statusLabel[m0.status]}</td><td class="num">${fmtEur(m0.lyRevenue)}</td></tr></tbody></table>`
        : ""
    }`;

  const fc7 = fcSum(7);
  const fc30 = fcSum(30);
  const nextBlock = `<table>
      <thead><tr><th>Horizonte</th><th class="num">Hab. OTB</th><th class="num">Ocupación OTB</th><th class="num">ADR OTB</th><th class="num">Ingresos OTB</th><th class="num">Pickup 7d</th><th class="num">Ingreso previsto</th></tr></thead>
      <tbody>
        <tr><td>Próximos 7 días</td><td class="num">${fmtInt(board.kpis.next7.roomsSold)}</td><td class="num">${fmtPct(board.kpis.next7.occPct)}</td><td class="num">${fmtEur(board.kpis.next7.adr)}</td><td class="num">${fmtEur(board.kpis.next7.revenue)}</td><td class="num">${board.kpis.next7.pickup7 !== null ? signed(board.kpis.next7.pickup7, (v) => fmtInt(v)) : "—"}</td><td class="num">${fmtEur(fc7)}</td></tr>
        <tr><td>Próximos 30 días</td><td class="num">${fmtInt(board.kpis.next30.roomsSold)}</td><td class="num">${fmtPct(board.kpis.next30.occPct)}</td><td class="num">${fmtEur(board.kpis.next30.adr)}</td><td class="num">${fmtEur(board.kpis.next30.revenue)}</td><td class="num">${board.kpis.next30.pickup7 !== null ? signed(board.kpis.next30.pickup7, (v) => fmtInt(v)) : "—"}</td><td class="num">${fmtEur(fc30)}</td></tr>
      </tbody></table>`;

  const criticals = board.criticalDates.slice(0, 5);
  const criticalBlock = criticals.length
    ? `<table><thead><tr><th>Fecha</th><th>Día</th><th class="num">Días</th><th>Motivo</th><th class="num">Ocup. OTB</th><th class="num">Ocup. prevista</th><th class="num">Pickup 7d</th><th>Recomendación</th></tr></thead>
      <tbody>${criticals
        .map(
          (c) =>
            `<tr><td>${c.date}</td><td>${xmlEscape(c.dow)}</td><td class="num">${c.daysOut}</td><td>${xmlEscape(c.reason)}</td><td class="num">${fmtPct(c.occPct)}</td><td class="num">${fmtPct(c.fcOccPct)}</td><td class="num">${c.pickup7 !== null ? signed(c.pickup7, (v) => fmtInt(v)) : "—"}</td><td>${c.recommendation ? xmlEscape(c.recommendation) : "—"}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="aviso">Sin fechas críticas detectadas en la ventana.</div>`;

  const body = [
    warnings,
    `<h2>Ayer · ${board.businessDate}</h2>`,
    yesterdayBlock,
    `<h2>Mes en curso (MTD) vs presupuesto vs año anterior</h2>`,
    mtdBlock,
    `<h2>Próximos 7 / 30 días</h2>`,
    nextBlock,
    `<h2>Top 5 fechas críticas</h2>`,
    criticalBlock
  ].join("\n");
  return printableHtml({ title: "Flash de dirección", hotel: board.propertyName, stamp, body });
}

// ---- pace_segmento -------------------------------------------------------------------
async function buildPaceSegmentoXls(propertyId: string, hotelName: string, from: string, to: string): Promise<string> {
  const bySegment = await getForecastBySegment({ propertyId, from, to });
  const preamble: SheetCell[][] = [
    ["Hotel", hotelName],
    ["Informe", "Pace por segmento"],
    ["Generado", `${madridStamp()} Europe/Madrid`],
    ["Rango", `${from} a ${to}`],
    ["Fuente", bySegment.source]
  ];
  if (!bySegment.rows.length) {
    return buildSpreadsheetMl([
      {
        name: "Resumen",
        rows: [...preamble, [], ["Aviso", "Sin previsión en el rango — genera el forecast primero."]]
      }
    ]);
  }
  type SegAgg = { segment: string; share: number; rooms: number; revenue: number };
  const bySeg = new Map<string, SegAgg>();
  for (const row of bySegment.rows) {
    let agg = bySeg.get(row.segment);
    if (!agg) {
      agg = { segment: row.segment, share: row.sharePercent, rooms: 0, revenue: 0 };
      bySeg.set(row.segment, agg);
    }
    agg.rooms += row.expectedRoomsSold;
    agg.revenue += row.expectedRoomRevenue;
  }
  const segments = [...bySeg.values()].sort((a, b) => b.revenue - a.revenue);
  const resumenRows: SheetCell[][] = [
    ...preamble,
    [],
    [
      { v: "Segmento", header: true },
      { v: "Share %", header: true },
      { v: "Hab. previstas", header: true },
      { v: "Ingreso previsto", header: true },
      { v: "ADR medio", header: true }
    ],
    ...segments.map((s) => [
      s.segment,
      round2(s.share),
      round2(s.rooms),
      round2(s.revenue),
      s.rooms > 0 ? round2(s.revenue / s.rooms) : null
    ] as SheetCell[])
  ];
  const sheets: SpreadsheetSheet[] = [{ name: "Resumen", rows: resumenRows }];
  for (const seg of segments.slice(0, 8)) {
    const rows = bySegment.rows.filter((r) => r.segment === seg.segment);
    sheets.push({
      name: seg.segment,
      rows: [
        [
          { v: "Fecha", header: true },
          { v: "Hab. previstas", header: true },
          { v: "Ingreso previsto", header: true },
          { v: "ADR", header: true },
          { v: "Share %", header: true }
        ],
        ...rows.map((r) => [dayUtc(r.forecastDate), r.expectedRoomsSold, r.expectedRoomRevenue, r.expectedAdr, r.sharePercent] as SheetCell[])
      ]
    });
  }
  return buildSpreadsheetMl(sheets);
}

// ---- meeting_pack ----------------------------------------------------------------------
async function buildMeetingPackHtml(propertyId: string, board: HistoryForecastBoard): Promise<string> {
  const pack = await getMeetingPack(propertyId);
  const stamp = madridStamp();
  const statusLabel: Record<string, string> = { ok: "OK", warn: "Atención", risk: "Riesgo", no_budget: "Sin presupuesto" };

  const paceTable = `<table><thead><tr><th>Horizonte</th><th class="num">Hab. OTB</th><th class="num">Ingresos OTB</th><th class="num">Hab. hace 7 días</th><th class="num">Δ hab.</th><th class="num">Δ ingresos</th></tr></thead>
    <tbody>${pack.pace.horizons
      .map(
        (h) =>
          `<tr><td>${h.horizonDays} días</td><td class="num">${fmtInt(h.otbRooms)}</td><td class="num">${fmtEur(h.otbRevenue)}</td><td class="num">${fmtInt(h.priorOtbRooms)}</td><td class="num">${signed(h.paceRooms, (v) => fmtInt(v))}</td><td class="num">${signed(h.paceRevenue, (v) => fmtEur(v))}</td></tr>`
      )
      .join("")}</tbody></table>`;

  const pickupTable = `<table><thead><tr><th>Ventana</th><th class="num">Reservas</th><th class="num">Room nights</th><th class="num">Ingresos</th></tr></thead>
    <tbody>${pack.pickup.windows
      .map(
        (w) =>
          `<tr><td>Últimos ${w.windowDays} días</td><td class="num">${fmtInt(w.reservations)}</td><td class="num">${fmtInt(w.roomNights)}</td><td class="num">${fmtEur(w.revenue)}</td></tr>`
      )
      .join("")}</tbody></table>`;

  const accuracyTable = pack.forecastAccuracy.length
    ? `<table><thead><tr><th>Métrica</th><th class="num">MAPE %</th><th class="num">Precisión %</th><th class="num">Muestras</th></tr></thead>
      <tbody>${pack.forecastAccuracy
        .map(
          (m) =>
            `<tr><td>${xmlEscape(m.metric)}</td><td class="num">${m.mape !== null ? fmtPct(m.mape) : "—"}</td><td class="num">${m.accuracy !== null ? fmtPct(m.accuracy) : "—"}</td><td class="num">${fmtInt(m.samples)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="aviso">Sin backtest de precisión disponible.</div>`;

  const bv = pack.budgetVariance;
  const budgetTable = `<table><thead><tr><th>Mes ${xmlEscape(bv.month)}</th><th class="num">Hab.</th><th class="num">Ingreso hab.</th><th class="num">ADR</th><th class="num">Ocupación</th></tr></thead>
    <tbody>
      <tr><td>Presupuesto</td><td class="num">${bv.budget ? fmtInt(bv.budget.roomsSold) : "—"}</td><td class="num">${bv.budget ? fmtEur(bv.budget.roomRevenue) : "—"}</td><td class="num">${bv.budget ? fmtEur(bv.budget.adr) : "—"}</td><td class="num">${bv.budget ? fmtPct(bv.budget.occupancyPct) : "—"}</td></tr>
      <tr><td>Proyección (real + forecast)</td><td class="num">${fmtInt(bv.forecast.roomsSold)}</td><td class="num">${fmtEur(bv.forecast.roomRevenue)}</td><td class="num">${fmtEur(bv.forecast.adr)}</td><td class="num">${fmtPct(bv.forecast.occupancyPct)}</td></tr>
      <tr><td>Real hasta hoy</td><td class="num">${fmtInt(bv.actual.roomsSold)}</td><td class="num">${fmtEur(bv.actual.roomRevenue)}</td><td class="num">${fmtEur(bv.actual.adr)}</td><td class="num">${fmtPct(bv.actual.occupancyPct)}</td></tr>
    </tbody></table>`;

  const monthsTable = `<table><thead><tr><th>Mes</th><th class="num">Proyección</th><th class="num">Presupuesto</th><th class="num">Gap</th><th>Estado</th><th class="num">Cierre LY</th></tr></thead>
    <tbody>${board.months
      .map(
        (m) =>
          `<tr><td>${xmlEscape(m.label)}</td><td class="num">${fmtEur(m.projectedRevenue)}</td><td class="num">${fmtEur(m.budgetRevenue)}</td><td class="num">${m.gapToBudget !== null ? signed(m.gapToBudget, (v) => fmtEur(v)) : "—"}</td><td class="status-${m.status}">${statusLabel[m.status]}</td><td class="num">${fmtEur(m.lyRevenue)}</td></tr>`
      )
      .join("")}</tbody></table>`;

  const criticalTable = board.criticalDates.length
    ? `<table><thead><tr><th>Fecha</th><th>Día</th><th class="num">Días</th><th>Motivo</th><th class="num">Ocup. OTB</th><th class="num">Ocup. prevista</th><th class="num">Pickup 7d</th><th class="num">Mediana compset</th><th>Recomendación</th></tr></thead>
      <tbody>${board.criticalDates
        .map(
          (c) =>
            `<tr><td>${c.date}</td><td>${xmlEscape(c.dow)}</td><td class="num">${c.daysOut}</td><td>${xmlEscape(c.reason)}</td><td class="num">${fmtPct(c.occPct)}</td><td class="num">${fmtPct(c.fcOccPct)}</td><td class="num">${c.pickup7 !== null ? signed(c.pickup7, (v) => fmtInt(v)) : "—"}</td><td class="num">${fmtEur(c.compsetMedian)}</td><td>${c.recommendation ? xmlEscape(c.recommendation) : "—"}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="aviso">Sin fechas críticas detectadas en la ventana.</div>`;

  const recsTable = pack.topRecommendations.length
    ? `<table><thead><tr><th>Fecha objetivo</th><th class="num">BAR actual</th><th class="num">BAR recomendada</th><th class="num">Confianza</th><th>Riesgo</th></tr></thead>
      <tbody>${pack.topRecommendations
        .map((r) => {
          const cur = num((r.current as Record<string, unknown> | null)?.bar);
          const next = num((r.recommended as Record<string, unknown> | null)?.bar);
          return `<tr><td>${xmlEscape(r.targetDate)}</td><td class="num">${cur !== undefined ? fmtEur(cur) : "—"}</td><td class="num">${next !== undefined ? fmtEur(next) : "—"}</td><td class="num">${fmtPct(r.confidence)}</td><td>${xmlEscape(r.riskLevel)}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : `<div class="aviso">Sin recomendaciones pendientes.</div>`;

  const compsetLine =
    pack.compSet.samples > 0
      ? `<p>Comp-set (próximos 14 días, ${fmtInt(pack.compSet.samples)} precios): mediana ${fmtEur(pack.compSet.median)} · mín ${fmtEur(pack.compSet.min)} · máx ${fmtEur(pack.compSet.max)}.</p>`
      : `<div class="aviso">Sin precios de comp-set en los próximos 14 días.</div>`;

  const body = [
    `<h2>1 · Pace y pickup</h2>`,
    paceTable,
    `<div style="height:6px"></div>`,
    pickupTable,
    `<h2>2 · Precisión del forecast (backtest 30 días)</h2>`,
    accuracyTable,
    `<h2>3 · Presupuesto y mes en curso + 3</h2>`,
    budgetTable,
    `<div style="height:6px"></div>`,
    monthsTable,
    `<h2>4 · Fechas críticas (top 10)</h2>`,
    criticalTable,
    `<h2>5 · Recomendaciones BAR pendientes</h2>`,
    recsTable,
    compsetLine
  ].join("\n");
  return printableHtml({ title: "Meeting pack de revenue", hotel: board.propertyName, stamp, body });
}

// ---- cierre_mensual ------------------------------------------------------------------------
type CierreData = {
  month: string;
  hotelName: string;
  current: Awaited<ReturnType<typeof getPeriodMetrics>>;
  ly: Awaited<ReturnType<typeof getPeriodMetrics>>;
  budget: { roomsSold: number | null; occupancy: number | null; adr: number | null; roomRevenue: number | null } | null;
  daily: Array<{
    date: string;
    rooms: number;
    occPct: number | null;
    adr: number | null;
    revpar: number | null;
    roomRevenue: number;
    totalRevenue: number;
    arrivals: number;
    departures: number;
    noShows: number;
    ooo: number;
    dataSource: string;
  }>;
  segments: Array<{ segment: string; reservations: number; rooms: number; revenue: number }>;
  warnings: string[];
};

async function loadCierreMensual(propertyId: string, hotelName: string, month: string): Promise<CierreData> {
  const monthStart = dayUtc(`${month}-01`);
  const monthEnd = endOfMonthUtc(monthStart);
  const yesterday = addDays(dayUtc(), -1);
  const dailyEnd = monthEnd.getTime() < yesterday.getTime() ? monthEnd : yesterday;
  const lyStart = addMonthsUtc(monthStart, -12);
  const lyEnd = endOfMonthUtc(lyStart);

  const [current, ly, budgetRow, dailyRows, segmentRows] = await Promise.all([
    getPeriodMetrics({ propertyId, from: isoDate(monthStart), to: isoDate(dailyEnd) }),
    getPeriodMetrics({ propertyId, from: isoDate(lyStart), to: isoDate(lyEnd) }),
    prisma.budget.findUnique({ where: { propertyId_periodMonth: { propertyId, periodMonth: month } } }),
    prisma.revenueDailySnapshot.findMany({
      where: {
        propertyId,
        snapshotDate: { gte: monthStart, lte: dailyEnd },
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null
      },
      orderBy: { snapshotDate: "asc" },
      select: {
        snapshotDate: true,
        totalOcc: true,
        occupancyPercent: true,
        adr: true,
        revpar: true,
        roomRevenue: true,
        totalRevenue: true,
        arrivalRooms: true,
        departureRooms: true,
        noShowRooms: true,
        oooRooms: true,
        dataSource: true
      }
    }),
    prisma.reservation.groupBy({
      by: ["marketSegment"],
      where: {
        propertyId,
        status: { in: CLOSED_STAY_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] },
        arrivalDate: { gte: monthStart, lte: monthEnd }
      },
      _count: { _all: true },
      _sum: { roomsCount: true, totalAmount: true }
    })
  ]);

  const warnings: string[] = [];
  if (!dailyRows.length) warnings.push("Sin datos de cierre (snapshots) en el mes.");
  if (!budgetRow) warnings.push("Sin presupuesto para el mes.");
  if (!ly.hasData) warnings.push("Sin datos del año anterior.");
  if (monthEnd.getTime() > yesterday.getTime()) warnings.push(`Mes en curso: cierre parcial hasta ${isoDate(dailyEnd)}.`);

  return {
    month,
    hotelName,
    current,
    ly,
    budget: budgetRow
      ? {
          roomsSold: budgetRow.budgetedRoomsSold,
          occupancy: decOrNull(budgetRow.budgetedOccupancy),
          adr: decOrNull(budgetRow.budgetedAdr),
          roomRevenue: decOrNull(budgetRow.budgetedRoomRevenue)
        }
      : null,
    daily: dailyRows.map((s) => ({
      date: isoDate(dayUtc(s.snapshotDate)),
      rooms: s.totalOcc,
      occPct: decOrNull(s.occupancyPercent),
      adr: decOrNull(s.adr),
      revpar: decOrNull(s.revpar),
      roomRevenue: round2(dec(s.roomRevenue)),
      totalRevenue: round2(dec(s.totalRevenue)),
      arrivals: s.arrivalRooms,
      departures: s.departureRooms,
      noShows: s.noShowRooms,
      ooo: s.oooRooms,
      dataSource: s.dataSource
    })),
    segments: segmentRows
      .map((r) => ({
        segment: r.marketSegment ?? "Sin segmento",
        reservations: r._count._all,
        rooms: r._sum.roomsCount ?? 0,
        revenue: round2(dec(r._sum.totalAmount))
      }))
      .sort((a, b) => b.revenue - a.revenue),
    warnings
  };
}

const CIERRE_RESUMEN_HEADER = ["Métrica", "Mes", "Presupuesto", "Año anterior"];
const CIERRE_DIARIO_HEADER = [
  "Fecha",
  "Hab. vendidas",
  "Ocupación %",
  "ADR",
  "RevPAR",
  "Ingreso hab.",
  "Ingreso total",
  "Llegadas",
  "Salidas",
  "No-shows",
  "OOO",
  "Fuente"
];
const CIERRE_SEGMENTOS_HEADER = ["Segmento (por fecha de llegada)", "Reservas", "Habitaciones", "Ingresos"];

function cierreResumenTable(d: CierreData): Array<[string, number | null, number | null, number | null]> {
  return [
    ["Habitaciones vendidas", d.current.roomsSold, d.budget?.roomsSold ?? null, d.ly.roomsSold],
    ["Ocupación %", d.current.occupancyPct, d.budget?.occupancy ?? null, d.ly.occupancyPct],
    ["ADR", d.current.adr, d.budget?.adr ?? null, d.ly.adr],
    ["RevPAR", d.current.revpar, null, d.ly.revpar],
    ["Ingreso habitaciones", d.current.roomRevenue, d.budget?.roomRevenue ?? null, d.ly.roomRevenue],
    ["Ingreso total", d.current.totalRevenue, null, d.ly.totalRevenue]
  ];
}

function buildCierreMensualXls(d: CierreData): string {
  const preamble: SheetCell[][] = [
    ["Hotel", d.hotelName],
    ["Informe", "Cierre mensual día a día"],
    ["Generado", `${madridStamp()} Europe/Madrid`],
    ["Mes", d.month],
    ...d.warnings.map((w) => ["Aviso", w] as SheetCell[])
  ];
  const resumen: SheetCell[][] = [
    ...preamble,
    [],
    CIERRE_RESUMEN_HEADER.map((h) => ({ v: h, header: true })),
    ...cierreResumenTable(d).map((r) => r as SheetCell[])
  ];
  const diario: SheetCell[][] = [
    CIERRE_DIARIO_HEADER.map((h) => ({ v: h, header: true })),
    ...d.daily.map(
      (s) =>
        [
          dayUtc(s.date),
          s.rooms,
          s.occPct,
          s.adr,
          s.revpar,
          s.roomRevenue,
          s.totalRevenue,
          s.arrivals,
          s.departures,
          s.noShows,
          s.ooo,
          s.dataSource
        ] as SheetCell[]
    )
  ];
  const segmentos: SheetCell[][] = [
    CIERRE_SEGMENTOS_HEADER.map((h) => ({ v: h, header: true })),
    ...d.segments.map((s) => [s.segment, s.reservations, s.rooms, s.revenue] as SheetCell[])
  ];
  return buildSpreadsheetMl([
    { name: "Resumen", rows: resumen },
    { name: "Diario", rows: diario },
    { name: "Segmentos", rows: segmentos }
  ]);
}

function buildCierreMensualCsv(d: CierreData): string {
  const preamble: Array<[string, string]> = [
    ["Hotel", d.hotelName],
    ["Informe", "Cierre mensual día a día"],
    ["Generado", `${madridStamp()} Europe/Madrid`],
    ["Mes", d.month],
    ...d.warnings.map((w) => ["Aviso", w] as [string, string])
  ];
  const resumenRows = cierreResumenTable(d).map(([label, cur, budget, ly]) => [
    csvEsc(label),
    csvNum(cur),
    csvNum(budget),
    csvNum(ly)
  ]);
  const diarioRows = d.daily.map((s) => [
    s.date,
    csvInt(s.rooms),
    csvNum(s.occPct),
    csvNum(s.adr),
    csvNum(s.revpar),
    csvNum(s.roomRevenue),
    csvNum(s.totalRevenue),
    csvInt(s.arrivals),
    csvInt(s.departures),
    csvInt(s.noShows),
    csvInt(s.ooo),
    csvEsc(s.dataSource)
  ]);
  const segmentRows = d.segments.map((s) => [csvEsc(s.segment), csvInt(s.reservations), csvInt(s.rooms), csvNum(s.revenue)]);
  return [
    ...csvLines(preamble, CIERRE_RESUMEN_HEADER, resumenRows),
    "",
    CIERRE_DIARIO_HEADER.map(csvEsc).join(";"),
    ...diarioRows.map((r) => r.join(";")),
    "",
    CIERRE_SEGMENTOS_HEADER.map(csvEsc).join(";"),
    ...segmentRows.map((r) => r.join(";"))
  ].join("\n");
}

// ---- generator --------------------------------------------------------------------------------
export type GeneratedExportMeta = {
  id: string;
  code: string;
  format: ExportFormat;
  filename: string;
  contentType: string;
  generatedAt: string;
  sizeBytes: number;
};
export type GenerateExportResponse = { export: GeneratedExportMeta; content: string };

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  xls: "application/vnd.ms-excel",
  pdf: "text/html;charset=utf-8"
};
const EXTENSIONS: Record<ExportFormat, string> = { csv: "csv", xls: "xls", pdf: "html" };

export async function generateExport(input: {
  context: UserContext;
  propertyId: string;
  exportCode: string;
  format: string;
  from?: string;
  to?: string;
  month?: string;
  correlationId: string;
  /** Legacy alias route keeps its historical audit action. */
  auditAction?: string;
}): Promise<GenerateExportResponse> {
  requirePermissions(input.context, ["revenue.history_forecast.export"]);
  const def = EXPORT_DEFS.find((d) => d.code === input.exportCode);
  if (!def) throw new BadRequestError(`Informe desconocido: ${input.exportCode}`);
  const format = input.format as ExportFormat;
  if (!def.formats.includes(format)) {
    throw new BadRequestError(`Formato '${input.format}' no disponible para ${def.code} (usa: ${def.formats.join(", ")}).`);
  }
  if (input.month !== undefined && !/^\d{4}-\d{2}$/.test(input.month)) {
    throw new BadRequestError("month debe tener formato YYYY-MM.");
  }
  if (input.from !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(input.from)) {
    throw new BadRequestError("from debe tener formato YYYY-MM-DD.");
  }
  if (input.to !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(input.to)) {
    throw new BadRequestError("to debe tener formato YYYY-MM-DD.");
  }

  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { id: true, name: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  const today = dayUtc();
  let content = "";
  switch (def.code) {
    case "hf_daily": {
      const board = await getHistoryForecastBoard(input.propertyId, {
        from: input.from ?? isoDate(addDays(today, -7)),
        to: input.to ?? isoDate(addDays(today, 90))
      });
      content = format === "xls" ? buildHfDailyXls(board, def.name) : buildHfDailyCsv(board, def.name);
      break;
    }
    case "pickup_daily": {
      const board = await getHistoryForecastBoard(input.propertyId, {
        from: input.from ?? isoDate(today),
        to: input.to ?? isoDate(addDays(today, 60))
      });
      content = buildPickupCsv(board, def.name);
      break;
    }
    case "flash_direccion": {
      const board = await getHistoryForecastBoard(input.propertyId, {});
      content = buildFlashHtml(board);
      break;
    }
    case "pace_segmento": {
      content = await buildPaceSegmentoXls(
        input.propertyId,
        property.name,
        input.from ?? isoDate(today),
        input.to ?? isoDate(addDays(today, 90))
      );
      break;
    }
    case "meeting_pack": {
      const board = await getHistoryForecastBoard(input.propertyId, {});
      content = await buildMeetingPackHtml(input.propertyId, board);
      break;
    }
    case "cierre_mensual": {
      const month = input.month ?? isoDate(addMonthsUtc(startOfMonthUtc(today), -1)).slice(0, 7);
      const data = await loadCierreMensual(input.propertyId, property.name, month);
      content = format === "xls" ? buildCierreMensualXls(data) : buildCierreMensualCsv(data);
      break;
    }
    default:
      throw new BadRequestError(`Informe desconocido: ${def.code}`);
  }

  const meta: GeneratedExportMeta = {
    id: createId("rexp"),
    code: def.code,
    format,
    filename: `anfitorio_${slugify(property.name)}_${def.code}_${isoDate(today)}.${EXTENSIONS[format]}`,
    contentType: CONTENT_TYPES[format],
    generatedAt: new Date().toISOString(),
    sizeBytes: Buffer.byteLength(content, "utf8")
  };

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.auditAction ?? "RevenueExportGenerated",
    entityType: "revenue_export",
    entityId: meta.id,
    afterJson: {
      exportCode: def.code,
      format,
      filename: meta.filename,
      sizeBytes: meta.sizeBytes,
      from: input.from ?? null,
      to: input.to ?? null,
      month: input.month ?? null
    },
    correlationId: input.correlationId
  });

  return { export: meta, content };
}
