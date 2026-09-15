/**
 * Finanzas · lote «iva-modelos» — shared wire contract between the API
 * (apps/api/src/modules/accounting/{vat-books,modelo-*,vat-settlement}.service.ts
 * + fiscal.routes.ts) and the admin-web fiscal screens.
 *
 * Design (2026-09-15):
 *   · The VAT books (`VatBookEntry`, RD 1619/2012) are the ONLY source of the
 *     Modelo 303 / 390 / 347. The API materialises them per document and tax
 *     rate; when a period has no materialised rows the models derive the same
 *     rows in memory from the documents (invoices, supplier bills, expenses)
 *     and say so in `avisos` — never a 409, never silent zeros.
 *   · Every AEAT model answers the same envelope (`FiscalModelReport`): a flat
 *     list of boxes (`casillas[]`), the headline totals, warnings, the sources
 *     used (book totals, ledger cross-check, settlement entry) and how the
 *     return is filed. `casilla` is the official box number when the mapping is
 *     certain (303: 01-09, 27-31, 45-46, 64-71, 78, 87, 110; 111: 01-30; 115:
 *     01-05; 180: 01-03) and `null` where the numbering must be validated with
 *     the tax advisor before filing (390 and 347 report by `clave`).
 *   · Money is a plain number with 2 decimals on the wire; the API computes in
 *     Decimal and rounds once per line. Dates are calendar days `YYYY-MM-DD`.
 *   · `presentacion.modo` is always `manual`: the official AEAT record layout
 *     (diseño de registro BOE) is NOT generated; the JSON/PDF summary is meant
 *     to be keyed into the AEAT sede (or handed to the gestoría).
 */

export type FiscalModelCode = "303" | "390" | "347" | "111" | "115" | "180";

export const FISCAL_MODEL_CODES: readonly FiscalModelCode[] = ["303", "390", "347", "111", "115", "180"];

export type VatBookName = "emitidas" | "recibidas" | "bienes_inversion";

export type VatBookSourceTypeCode = "invoice" | "rectification" | "simplified" | "supplier_bill" | "expense";

export type VatPeriodicityCode = "quarterly" | "monthly";

export type VatRegimeCode = "general" | "redeme" | "recargo";

export type FiscalPeriodType = "quarterly" | "monthly" | "annual";

/** A settlement period: `2026-Q3` (quarterly), `2026-09` (monthly) or `2026` (annual models). */
export type FiscalPeriodDto = {
  code: string;
  type: FiscalPeriodType;
  year: number;
  quarter: 1 | 2 | 3 | 4 | null;
  month: number | null;
  /** First calendar day of the period (inclusive). */
  from: string;
  /** Last calendar day of the period (inclusive). */
  to: string;
  /** AEAT period code: `1T`..`4T`, `01`..`12` or `0A` (annual). */
  aeatPeriod: string;
};

export type FiscalBoxKind = "base" | "tipo" | "cuota" | "resultado" | "info" | "contador";

export type FiscalBox = {
  /** Official box number (`"01"`, `"110"`) or null when it must be validated before filing. */
  casilla: string | null;
  /** Stable machine key (`DEV_BASE_10`, `DED_CUOTA_CORRIENTE`, `RESULTADO`). */
  clave: string;
  descripcion: string;
  /** Form section the box belongs to (Spanish, as printed on the form). */
  seccion: string;
  importe: number;
  tipo: FiscalBoxKind;
};

export type VatBookTotalsByRate = {
  rate: number;
  filas: number;
  base: number;
  cuota: number;
  total: number;
  retencion: number;
};

export type VatBookSummary = {
  filas: number;
  base: number;
  cuota: number;
  total: number;
  retencion: number;
  porTipo: VatBookTotalsByRate[];
};

/** Ledger cross-check of the 303: what the journal (477x / 472x) says for the same period. */
export type FiscalLedgerCrossCheck = {
  /** Journal lines found on 477x / 472x for the period (excluding the settlement entry itself). */
  apuntes: number;
  cuotaRepercutida: number;
  cuotaSoportada: number;
  /** Per rate: book quota vs ledger quota; only rates with a difference > 0.005 are listed. */
  diferencias: Array<{ libro: "repercutido" | "soportado"; rate: number | null; libros: number; diario: number; diferencia: number }>;
  cuadra: boolean;
};

export type FiscalReportSources = {
  /** `libros` = materialised VatBookEntry rows; `documentos` = derived in memory from invoices/bills/expenses (not materialised yet). */
  origen: "libros" | "documentos" | "retenciones" | "modelos_303";
  libros?: Partial<Record<VatBookName, VatBookSummary>>;
  diario?: FiscalLedgerCrossCheck;
  liquidacion?: { journalEntryId: string; entryNumber: number | null; fiscalYearCode: string | null; entryDate: string; reversed: boolean } | null;
  /** Number of source documents / withholding records read. */
  registros?: number;
  periodos?: Array<{ periodo: string; resultado: number }>;
};

export type FiscalPresentation = {
  modo: "manual";
  ficheroOficial: false;
  nota: string;
};

export type FiscalModelReport = {
  modelo: FiscalModelCode;
  titulo: string;
  organizationId: string;
  propertyId: string | null;
  periodo: FiscalPeriodDto;
  declarante: { nif: string | null; nombre: string | null };
  casillas: FiscalBox[];
  totales: Record<string, number>;
  avisos: string[];
  fuentes: FiscalReportSources;
  /** Per-third-party (347), per-lessor (180) or per-period (390) detail rows. */
  detalle: Array<Record<string, string | number | null>>;
  presentacion: FiscalPresentation;
  generatedAt: string;
};

export type VatBookRowDto = {
  id: string | null;
  book: VatBookName;
  date: string;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  base: number;
  rate: number;
  quota: number;
  total: number;
  retention: number;
  taxFigure: string;
  surchargeRate: number | null;
  surchargeQuota: number | null;
  sourceType: VatBookSourceTypeCode;
  sourceId: string;
  period: string;
  deductible: boolean;
  propertyId: string | null;
};

export type VatBookResponse = {
  organizationId: string;
  propertyId: string | null;
  book: VatBookName;
  periodo: FiscalPeriodDto;
  origen: "libros" | "documentos";
  rows: VatBookRowDto[];
  resumen: VatBookSummary;
  avisos: string[];
};

export type VatSettingsDto = {
  organizationId: string;
  periodicity: VatPeriodicityCode;
  regime: VatRegimeCode;
  prorrataPct: number | null;
  taxFigure: "IVA" | "IGIC" | "IPSI";
  /** false when the organisation has no row yet (defaults shown). */
  persisted: boolean;
};

export type VatBooksRebuildResponse = {
  organizationId: string;
  propertyId: string | null;
  from: string;
  to: string;
  deleted: number;
  created: Record<VatBookName, number>;
  documentos: { facturas: number; anulaciones: number; facturasRecibidas: number; gastos: number };
  avisos: string[];
};

export type VatSettlementLineDto = {
  accountCode: string;
  description: string;
  debit: number;
  credit: number;
  taxRateCode: string | null;
  taxBase: number | null;
};

export type VatSettlementPreview = {
  organizationId: string;
  periodo: FiscalPeriodDto;
  /** `to_pay` → H 4750; `to_offset` → D 4700; `zero` → nothing to post. */
  resultado: "to_pay" | "to_offset" | "zero";
  importe: number;
  compensacionAplicada: number;
  compensacionPendienteInicial: number;
  compensacionPendienteFinal: number;
  lines: VatSettlementLineDto[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  avisos: string[];
  /** Existing (non-reversed) settlement entry for the period, if any. */
  existing: { journalEntryId: string; entryNumber: number | null; fiscalYearCode: string | null; entryDate: string } | null;
  modelo303: FiscalModelReport;
};

export type VatSettlementResult = {
  journalEntryId: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  entryDate: string;
  resultado: VatSettlementPreview["resultado"];
  importe: number;
  lines: VatSettlementLineDto[];
};

export type VatSettlementReversalResult = {
  reversedJournalEntryId: string;
  reversalJournalEntryId: string;
  entryNumber: number | null;
  entryDate: string;
};
