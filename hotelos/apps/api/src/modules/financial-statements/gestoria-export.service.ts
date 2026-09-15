// Exportación a gestoría (Finanzas · lote usali-cuentas).
//
// Formats (GestoriaExportFormat):
//   · csv_universal  — ALWAYS: one row per journal line, columns
//     fecha;asiento;cuenta;concepto;debe;haber;documento;nif;base;iva
//     (`;`, UTF-8 BOM, DD/MM/YYYY, decimal comma). `asiento` is the entry
//     number of the fiscal year; an entry a legacy writer left unnumbered
//     (entryNumber null, contract §1.3) is exported as "P-<id>" so its lines
//     still group, and the export result counts them (`unnumbered`).
//   · vat_books_csv  — ALWAYS: the VAT books (VatBookEntry) of the period.
//   · contaplus_diario — «compatible ContaPlus / Sage 50 Diario»: the core
//     columns of the classic ContaPlus Diario table (ASIEN, FECHA, SUBCTA,
//     CONTRA, CONCEPTO, EURODEBE, EUROHABER, FACTURA, BASEEURO, IVA,
//     DOCUMENTO) as `;` CSV; sub-account codes are right-padded with zeros to
//     the company's sub-account length (default 8: 705.1 → 70510000, 4300 →
//     43000000). The layout is documented in the runbook and every export of
//     this format is flagged validateWithAdvisor = true: the gestoría must
//     confirm the sub-account length and the import path before the first
//     real import.
//   · a3 — NOT implemented: the A3 «enlace contable» fixed-width record layout
//     is not known with confidence, and a wrong file would be worse than none.
//     The API answers 409 EXPORT_FORMAT_NOT_IMPLEMENTED and points to
//     csv_universal (A3ECO/A3CON import CSV/Excel through their assistant).
//
// Content is stored inline on GestoriaExport (no object storage exists in the
// API); exports above MAX_INLINE_BYTES are refused with 413 EXPORT_TOO_LARGE
// («divide el periodo»).

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { accountDigits } from "../accounting/chart-of-accounts.service.js";
import type { GestoriaExportFormatInfo, GestoriaExportFormatKey, GestoriaExportRow } from "../../../../../packages/shared/src/financial-statements-types.js";
import { csvDocument, type CsvCell } from "./csv.js";
import { decimalComma, money, spanishDate } from "./money.js";
import { isoDay, prismaFinancialStatementsSource, type DocumentRef, type FinancialStatementsSource, type JournalLineExportRow } from "./source.js";

export const MAX_INLINE_BYTES = 20_000_000;
export const DEFAULT_SUBACCOUNT_LENGTH = 8;

export const CSV_UNIVERSAL_COLUMNS = ["fecha", "asiento", "cuenta", "concepto", "debe", "haber", "documento", "nif", "base", "iva"] as const;
export const VAT_BOOKS_COLUMNS = [
  "libro", "fecha", "serie", "numero", "nif", "nombre", "base", "tipo", "cuota", "total", "retencion", "figura", "recargo_tipo", "recargo_cuota", "periodo", "deducible", "origen_tipo", "origen_id"
] as const;
export const CONTAPLUS_COLUMNS = ["ASIEN", "FECHA", "SUBCTA", "CONTRA", "CONCEPTO", "EURODEBE", "EUROHABER", "FACTURA", "BASEEURO", "IVA", "DOCUMENTO"] as const;

export const GESTORIA_FORMATS: GestoriaExportFormatInfo[] = [
  {
    format: "csv_universal",
    label: "CSV universal de asientos",
    implemented: true,
    validateWithAdvisor: false,
    columns: [...CSV_UNIVERSAL_COLUMNS],
    description: "Una fila por línea de asiento; separador «;», UTF-8 con BOM, fecha DD/MM/AAAA, coma decimal. Lo importa cualquier gestoría o programa contable."
  },
  {
    format: "vat_books_csv",
    label: "Libros registro de IVA (CSV)",
    implemented: true,
    validateWithAdvisor: false,
    columns: [...VAT_BOOKS_COLUMNS],
    description: "Facturas emitidas, recibidas y bienes de inversión del periodo (RD 1619/2012), una fila por documento y tipo impositivo."
  },
  {
    format: "contaplus_diario",
    label: "Diario compatible ContaPlus / Sage 50",
    implemented: true,
    validateWithAdvisor: true,
    columns: [...CONTAPLUS_COLUMNS],
    description: "Columnas del Diario de ContaPlus (ASIEN, FECHA, SUBCTA, CONTRA, CONCEPTO, EURODEBE, EUROHABER, FACTURA, BASEEURO, IVA, DOCUMENTO) en CSV «;»; subcuentas rellenadas con ceros a la longitud de la empresa (8 por defecto). Validar con la gestoría antes de la primera importación real."
  },
  {
    format: "a3",
    label: "A3 (enlace contable)",
    implemented: false,
    validateWithAdvisor: true,
    columns: [],
    description: "Pendiente: el diseño de registro del enlace contable de A3 no está implementado. Usa el CSV universal (A3ECO/A3CON lo importan con su asistente de CSV/Excel)."
  }
];

export type ExportBuild = { content: string; rowCount: number; validateWithAdvisor: boolean; unnumbered: number };

type SourceKind = "invoice" | "supplier_bill" | "expense";

function documentKind(sourceType: string): SourceKind | null {
  switch (sourceType) {
    case "invoice":
    case "invoice_rectification":
    case "invoice_cancellation":
      return "invoice";
    case "supplier_bill":
    case "supplier_bill_payment":
      return "supplier_bill";
    case "expense":
      return "expense";
    default:
      return null;
  }
}

const SOURCE_LABELS: Record<string, string> = {
  folio_line: "Cargo en folio",
  payment: "Cobro",
  payment_refund: "Devolución de cobro",
  invoice: "Factura emitida",
  invoice_rectification: "Factura rectificativa",
  invoice_cancellation: "Anulación de factura",
  pos_ticket: "Ticket TPV",
  supplier_bill: "Factura recibida",
  supplier_bill_payment: "Pago a proveedor",
  expense: "Gasto",
  payroll_slip: "Nómina",
  payroll_payment: "Pago de nóminas",
  commission: "Comisión de canal",
  depreciation: "Amortización",
  vat_settlement: "Liquidación de IVA",
  cash_closure: "Arqueo de caja",
  card_settlement: "Liquidación de datáfono",
  tourist_tax: "Tasa turística",
  manual: "Asiento manual",
  regularization: "Regularización",
  closing: "Cierre",
  opening: "Apertura",
  reversal: "Anulación de asiento"
};

export function entryLabel(line: Pick<JournalLineExportRow, "lineDescription" | "description" | "sourceType">): string {
  return line.lineDescription ?? line.description ?? SOURCE_LABELS[line.sourceType] ?? line.sourceType;
}

export function entryNumberLabel(line: Pick<JournalLineExportRow, "entryNumber" | "entryId">): string {
  return line.entryNumber === null ? `P-${line.entryId}` : String(line.entryNumber);
}

/** ContaPlus sub-account: digits of the PGC code right-padded with zeros to `length` (705.1 → 70510000). */
export function contaplusSubaccount(code: string, length = DEFAULT_SUBACCOUNT_LENGTH): string {
  const digits = accountDigits(code);
  if (digits.length >= length) return digits.slice(0, length);
  return digits.padEnd(length, "0");
}

async function collectLines(source: FinancialStatementsSource, query: { organizationId: string; propertyId?: string | null; from: string; to: string }) {
  const lines: JournalLineExportRow[] = [];
  const wanted: Record<SourceKind, Set<string>> = { invoice: new Set(), supplier_bill: new Set(), expense: new Set() };
  for await (const batch of source.journalLines(query)) {
    for (const line of batch) {
      lines.push(line);
      const kind = documentKind(line.sourceType);
      if (kind && line.sourceId) wanted[kind].add(line.sourceId);
    }
  }
  const refs: Record<SourceKind, Map<string, DocumentRef>> = { invoice: new Map(), supplier_bill: new Map(), expense: new Map() };
  for (const kind of Object.keys(wanted) as SourceKind[]) {
    const ids = Array.from(wanted[kind]);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = await source.documentRefs(kind, ids.slice(i, i + 500));
      for (const [id, ref] of chunk) refs[kind].set(id, ref);
    }
  }
  const refOf = (line: JournalLineExportRow): DocumentRef | null => {
    const kind = documentKind(line.sourceType);
    return kind && line.sourceId ? (refs[kind].get(line.sourceId) ?? null) : null;
  };
  return { lines, refOf };
}

const TAX_ACCOUNT = (code: string): boolean => /^(472|477)/.test(accountDigits(code));

export function csvUniversalRow(line: JournalLineExportRow, ref: DocumentRef | null): CsvCell[] {
  return [
    spanishDate(line.entryDate),
    entryNumberLabel(line),
    line.accountCode,
    entryLabel(line),
    decimalComma(money(line.debit)),
    decimalComma(money(line.credit)),
    line.reference ?? ref?.number ?? "",
    ref?.nif ?? "",
    TAX_ACCOUNT(line.accountCode) && line.taxBase !== null ? decimalComma(money(line.taxBase)) : "",
    TAX_ACCOUNT(line.accountCode) ? (line.taxRateCode ?? "") : ""
  ];
}

/** Entries (not lines) a legacy writer left without entryNumber: exported as P-<id>, reported to the caller. */
export function countUnnumbered(lines: JournalLineExportRow[]): number {
  return new Set(lines.filter((l) => l.entryNumber === null).map((l) => l.entryId)).size;
}

export async function buildCsvUniversal(source: FinancialStatementsSource, query: { organizationId: string; propertyId?: string | null; from: string; to: string }): Promise<ExportBuild> {
  const { lines, refOf } = await collectLines(source, query);
  const rows = lines.map((line) => csvUniversalRow(line, refOf(line)));
  return { content: csvDocument([...CSV_UNIVERSAL_COLUMNS], rows), rowCount: rows.length, validateWithAdvisor: false, unnumbered: countUnnumbered(lines) };
}

export function contaplusRow(line: JournalLineExportRow, siblings: JournalLineExportRow[], ref: DocumentRef | null, length: number): CsvCell[] {
  const others = siblings.filter((s) => s.lineId !== line.lineId);
  const contra = others.length === 1 ? contaplusSubaccount(others[0]!.accountCode, length) : "";
  return [
    entryNumberLabel(line),
    spanishDate(line.entryDate),
    contaplusSubaccount(line.accountCode, length),
    contra,
    entryLabel(line).slice(0, 40),
    decimalComma(money(line.debit)),
    decimalComma(money(line.credit)),
    line.reference ?? ref?.number ?? "",
    TAX_ACCOUNT(line.accountCode) && line.taxBase !== null ? decimalComma(money(line.taxBase)) : "",
    TAX_ACCOUNT(line.accountCode) ? (line.taxRateCode ?? "") : "",
    line.reference ?? ref?.number ?? ""
  ];
}

export async function buildContaplusDiario(
  source: FinancialStatementsSource,
  query: { organizationId: string; propertyId?: string | null; from: string; to: string; subaccountLength?: number }
): Promise<ExportBuild> {
  const length = query.subaccountLength ?? DEFAULT_SUBACCOUNT_LENGTH;
  const { lines, refOf } = await collectLines(source, query);
  const byEntry = new Map<string, JournalLineExportRow[]>();
  for (const line of lines) byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);
  const rows = lines.map((line) => contaplusRow(line, byEntry.get(line.entryId) ?? [line], refOf(line), length));
  return { content: csvDocument([...CONTAPLUS_COLUMNS], rows), rowCount: rows.length, validateWithAdvisor: true, unnumbered: countUnnumbered(lines) };
}

export async function buildVatBooksCsv(source: FinancialStatementsSource, query: { organizationId: string; propertyId?: string | null; from: string; to: string }): Promise<ExportBuild> {
  const entries = await source.vatBookEntries(query);
  const rows = entries.map((e): CsvCell[] => [
    e.book,
    spanishDate(e.date),
    e.series ?? "",
    e.number ?? "",
    e.counterpartyNif ?? "",
    e.counterpartyName ?? "",
    decimalComma(money(e.base)),
    decimalComma(e.rate.toFixed(2)),
    decimalComma(money(e.quota)),
    decimalComma(money(e.total)),
    decimalComma(money(e.retention)),
    e.taxFigure,
    e.surchargeRate === null ? "" : decimalComma(e.surchargeRate.toFixed(2)),
    e.surchargeQuota === null ? "" : decimalComma(money(e.surchargeQuota)),
    e.period,
    e.deductible ? "S" : "N",
    e.sourceType,
    e.sourceId
  ]);
  return { content: csvDocument([...VAT_BOOKS_COLUMNS], rows), rowCount: rows.length, validateWithAdvisor: false, unnumbered: 0 };
}

export function exportFileName(row: { format: GestoriaExportFormatKey; periodFrom: string; periodTo: string; organizationId: string }): string {
  const stem = { csv_universal: "asientos", vat_books_csv: "libros-iva", contaplus_diario: "diario-contaplus", a3: "a3" }[row.format];
  return `${stem}_${row.organizationId}_${row.periodFrom}_${row.periodTo}.csv`;
}

function toWire(row: {
  id: string;
  organizationId: string;
  format: string;
  periodFrom: Date;
  periodTo: Date;
  rowCount: number;
  validateWithAdvisor: boolean;
  createdBy: string | null;
  createdAt: Date;
  inline?: string | null;
}): GestoriaExportRow {
  const periodFrom = isoDay(row.periodFrom);
  const periodTo = isoDay(row.periodTo);
  const format = row.format as GestoriaExportFormatKey;
  return {
    id: row.id,
    organizationId: row.organizationId,
    format,
    periodFrom,
    periodTo,
    rowCount: row.rowCount,
    validateWithAdvisor: row.validateWithAdvisor,
    fileName: exportFileName({ format, periodFrom, periodTo, organizationId: row.organizationId }),
    sizeBytes: row.inline ? Buffer.byteLength(row.inline, "utf8") : 0,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString()
  };
}

export async function createGestoriaExport(input: {
  context: UserContext;
  format: GestoriaExportFormatKey;
  from: string;
  to: string;
  propertyId?: string | null;
  subaccountLength?: number;
  correlationId: string;
  source?: FinancialStatementsSource;
}): Promise<GestoriaExportRow & { unnumbered: number }> {
  requirePermissions(input.context, ["analytics.export"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  if (input.propertyId) {
    const properties = await source.properties(organizationId);
    if (!properties.some((p) => p.id === input.propertyId)) throw new NotFoundError("Propiedad no encontrada.");
  }
  const query = { organizationId, propertyId: input.propertyId ?? null, from: input.from, to: input.to };
  let build: ExportBuild;
  switch (input.format) {
    case "csv_universal":
      build = await buildCsvUniversal(source, query);
      break;
    case "vat_books_csv":
      build = await buildVatBooksCsv(source, query);
      break;
    case "contaplus_diario":
      build = await buildContaplusDiario(source, { ...query, subaccountLength: input.subaccountLength });
      break;
    case "a3":
      throw new HttpError(409, "El formato A3 no está implementado: usa el CSV universal de asientos (A3 lo importa con su asistente de CSV/Excel).", true, {
        code: "EXPORT_FORMAT_NOT_IMPLEMENTED",
        format: "a3",
        alternative: "csv_universal"
      });
  }
  const size = Buffer.byteLength(build.content, "utf8");
  if (size > MAX_INLINE_BYTES) {
    throw new HttpError(413, `La exportación ocupa ${size} bytes (máximo ${MAX_INLINE_BYTES}): divide el periodo.`, true, { code: "EXPORT_TOO_LARGE", sizeBytes: size, maxBytes: MAX_INLINE_BYTES });
  }
  const row = await prisma.gestoriaExport.create({
    data: {
      organizationId,
      format: input.format,
      periodFrom: new Date(`${input.from}T00:00:00.000Z`),
      periodTo: new Date(`${input.to}T00:00:00.000Z`),
      inline: build.content,
      rowCount: build.rowCount,
      validateWithAdvisor: build.validateWithAdvisor,
      createdBy: input.context.userId
    }
  });
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GESTORIA_EXPORT_CREATED",
    entityType: "gestoria_export",
    entityId: row.id,
    afterJson: { format: input.format, periodFrom: input.from, periodTo: input.to, rowCount: build.rowCount, sizeBytes: size, propertyId: input.propertyId ?? null },
    correlationId: input.correlationId
  });
  return { ...toWire(row), unnumbered: build.unnumbered };
}

export async function listGestoriaExports(input: { context: UserContext; format?: GestoriaExportFormatKey | null; limit?: number }): Promise<GestoriaExportRow[]> {
  requirePermissions(input.context, ["analytics.export"]);
  const rows = await prisma.gestoriaExport.findMany({
    where: { organizationId: input.context.organizationId, ...(input.format ? { format: input.format } : {}) },
    orderBy: { createdAt: "desc" },
    take: input.limit ?? 50,
    select: { id: true, organizationId: true, format: true, periodFrom: true, periodTo: true, rowCount: true, validateWithAdvisor: true, createdBy: true, createdAt: true, inline: true }
  });
  return rows.map(toWire);
}

export async function getGestoriaExport(input: { context: UserContext; exportId: string }): Promise<{ row: GestoriaExportRow; content: string }> {
  requirePermissions(input.context, ["analytics.export"]);
  const row = await prisma.gestoriaExport.findFirst({ where: { id: input.exportId, organizationId: input.context.organizationId } });
  if (!row) throw new NotFoundError("Exportación no encontrada.");
  return { row: toWire(row), content: row.inline ?? "" };
}
