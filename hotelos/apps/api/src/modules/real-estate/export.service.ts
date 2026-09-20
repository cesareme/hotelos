// Activo inmobiliario · exportación CSV (Tanda ACT · L6, diseño §7 «export»):
// GET /organizations/:organizationId/real-estate/export?format=csv&what=overview|calendar&year=
// devuelve la vista de grupo o el calendario anual como `text/csv` con escritor
// propio (sin librerías): separador `;`, UTF-8 con BOM, fin de línea CRLF,
// cabeceras en español, importes con coma decimal (como el diario de
// accounting.service.ts), celdas entrecomilladas cuando llevan `;`, comillas o
// saltos de línea (las comillas se doblan). Nombre del fichero:
// `activo-inmobiliario-<what>-<año>.csv` (content-disposition attachment).
//
// Permiso: real_estate.read + ámbito (decisión del plan: sin clave `export`);
// las filas exportadas son exactamente las de la vista (mismo filtro de
// centros). La vista de grupo exporta una línea por centro SIN línea de totales
// (los totales van en el JSON de la vista; el CSV se suma en la hoja).

import { z } from "zod";
import type { IsoDay, MoneyString, PercentString, RealEstateGroupOverview } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { RealEstateYearQuerySchema } from "../../schemas/real-estate.schemas.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { REAL_ESTATE_TENURE_KIND_LABELS } from "./alerts.pure.js";
import { getRealEstateGroupCalendar, REAL_ESTATE_CALENDAR_KIND_LABELS, type RealEstateCalendarYear } from "./calendar.service.js";
import { getRealEstateGroupOverview, type ScopeSubject } from "./group.service.js";
import { toIsoDay } from "./vigencias.js";

// ---------------------------------------------------------------------------
// Escritor CSV (puro)
// ---------------------------------------------------------------------------

export const CSV_SEPARATOR = ";";
export const CSV_BOM = "\uFEFF";
export const CSV_EOL = "\r\n";
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** Texto que una hoja de cálculo interpretaría como fórmula (inyección CSV/DDE): =, +, -, @, tabulador o retorno al inicio. */
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Celda: vacío para null / undefined; entrecomillada (comillas dobladas) si
 * lleva `;`, comillas o saltos de línea. Un texto que empieza por `=`, `+`,
 * `-`, `@`, tabulador o retorno se neutraliza con un apóstrofo inicial y se
 * entrecomilla (ACT-REV-05: los títulos, pólizas y referencias son texto libre
 * de usuarios). Los números llegan como número y no se tocan.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const neutralized = CSV_FORMULA_PREFIX.test(value);
  const text = neutralized ? `'${value}` : value;
  return neutralized || /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

/** Importe "1234.56" → "1234,56" (coma decimal); vacío sin valor. */
export function csvMoney(value: MoneyString | null | undefined): string {
  return value ? value.replace(".", ",") : "";
}

/** Porcentaje "83.33" → "83,33"; vacío sin valor. */
export function csvPercent(value: PercentString | null | undefined): string {
  return value ? value.replace(".", ",") : "";
}

/** Documento completo: BOM + cabecera + filas, CRLF y CRLF final. */
export function toCsv(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const lines = [header.map(csvCell).join(CSV_SEPARATOR), ...rows.map((row) => row.join(CSV_SEPARATOR))];
  return `${CSV_BOM}${lines.join(CSV_EOL)}${CSV_EOL}`;
}

// ---------------------------------------------------------------------------
// Vista de grupo → CSV
// ---------------------------------------------------------------------------

export const GROUP_OVERVIEW_CSV_HEADER = [
  "Centro",
  "Código",
  "Tenencia",
  "Valor catastral",
  "Última tasación",
  "Carga fiscal anual",
  "Documentos vigentes (%)",
  "Inspecciones en plazo (%)",
  "Alertas altas",
  "Alertas abiertas"
] as const;

export function groupOverviewToCsv(overview: RealEstateGroupOverview): string {
  const rows = overview.rows.map((row) => [
    csvCell(row.propertyName),
    csvCell(row.propertyCode),
    csvCell(row.tenureKind ? (REAL_ESTATE_TENURE_KIND_LABELS[row.tenureKind] ?? row.tenureKind) : null),
    csvMoney(row.cadastralValueTotal),
    csvMoney(row.lastValuationValue),
    csvMoney(row.annualTaxBurden),
    csvPercent(row.documentsValidPct),
    csvPercent(row.inspectionsOnTimePct),
    csvCell(row.openAlertsHigh),
    csvCell(row.openAlerts)
  ]);
  return toCsv(GROUP_OVERVIEW_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------------
// Calendario → CSV
// ---------------------------------------------------------------------------

export const CALENDAR_CSV_HEADER = ["Mes", "Fecha", "Centro", "Código", "Tipo", "Clave", "Descripción", "Entidad", "Id"] as const;

export function calendarToCsv(calendar: RealEstateCalendarYear): string {
  const propertyOf = new Map(calendar.properties.map((property) => [property.propertyId, property] as const));
  const rows: string[][] = [];
  for (const month of calendar.months) {
    for (const event of month.events) {
      const property = propertyOf.get(event.propertyId);
      rows.push([
        csvCell(month.month),
        csvCell(event.dueAt),
        csvCell(property?.propertyName ?? event.propertyId),
        csvCell(property?.propertyCode ?? null),
        csvCell(REAL_ESTATE_CALENDAR_KIND_LABELS[event.kind] ?? event.kind),
        csvCell(event.kind),
        csvCell(event.label),
        csvCell(event.entityType),
        csvCell(event.entityId)
      ]);
    }
  }
  return toCsv(CALENDAR_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------------
// Consulta y fichero
// ---------------------------------------------------------------------------

export const REAL_ESTATE_EXPORT_WHAT = ["overview", "calendar"] as const;
export type RealEstateExportWhat = (typeof REAL_ESTATE_EXPORT_WHAT)[number];

export const RealEstateExportQuerySchema = RealEstateYearQuerySchema.extend({
  format: z.enum(["csv"], { errorMap: () => ({ message: "format debe ser csv." }) }).optional(),
  what: z.enum(REAL_ESTATE_EXPORT_WHAT, { errorMap: () => ({ message: "what debe ser overview o calendar." }) })
});
export type RealEstateExportQueryInput = z.output<typeof RealEstateExportQuerySchema>;

export function exportFileName(what: RealEstateExportWhat, year: number): string {
  return `activo-inmobiliario-${what}-${year}.csv`;
}

export type RealEstateExportFile = { fileName: string; contentType: string; content: string };

/** Vista de grupo o calendario del año como CSV; el año (por defecto el actual) nombra el fichero y filtra el calendario. */
export async function exportRealEstateGroup(context: UserContext & ScopeSubject, organizationId: string, query: unknown, today: IsoDay = toIsoDay(new Date())): Promise<RealEstateExportFile> {
  const filter = parseOr400(RealEstateExportQuerySchema, query ?? {}, "Filtro de la exportación");
  const year = filter.year ?? Number(today.slice(0, 4));
  const content = filter.what === "overview" ? groupOverviewToCsv(await getRealEstateGroupOverview(context, organizationId, today)) : calendarToCsv(await getRealEstateGroupCalendar(context, organizationId, { year: String(year) }, today));
  return { fileName: exportFileName(filter.what, year), contentType: CSV_CONTENT_TYPE, content };
}
