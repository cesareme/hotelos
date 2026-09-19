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

/** `sage200` (Tanda 7c): fila importada de los libros de IVA de Sage 200 (`rebuildVatBooks` la conserva). */
export type VatBookSourceTypeCode = "invoice" | "rectification" | "simplified" | "supplier_bill" | "expense" | "sage200";

/**
 * FIX-1 · F2: régimen de IVA de una fila del libro (enum `VatBookRegime` de Prisma). `null` = sin
 * clasificar (filas anteriores a F2 y escritores nativos): el 303 la trata como operación interior.
 *   interior         régimen general (casillas 01-09 / 28-31)
 *   isp              inversión del sujeto pasivo: autofactura emitida (12/13) y cuota soportada (38/39)
 *   aib              adquisición intracomunitaria: autofactura emitida (10/11) y cuota soportada (36/37)
 *   importacion      DUA / tipo de factura F5 (32/33)
 *   exento_no_sujeto 0 % exenta o no sujeta por reglas de localización (120, sin cuota)
 */
export type VatBookRegimeCode = "interior" | "isp" | "aib" | "importacion" | "exento_no_sujeto";

export const VAT_BOOK_REGIME_CODES: readonly VatBookRegimeCode[] = ["interior", "isp", "aib", "importacion", "exento_no_sujeto"];

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

/**
 * FIX-1 · F3 (B-2): a settlement entry imported from Sage 200 («LIQUI IVA 1T», pattern 4750/4700 together with
 * 477/472) dated inside the period of the 303. `resultado` = Σ 4750 (haber − debe) − Σ 4700 debe: positive =
 * a ingresar, negative = a compensar. Historical: shown, never posted by ehotelOS.
 */
export type FiscalHistoricalSettlementDto = {
  journalEntryId: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  entryDate: string;
  description: string | null;
  resultado: number;
};

/** FIX-1 · F3 (E-03): aviso (API and screens) of a centre breakdown over books imported from Sage without a delegation. */
export const SAGE_NO_CENTRE_AVISO = "Desglose por centro no disponible para lotes Sage sin delegación: las filas importadas no llevan centro.";

export type FiscalReportSources = {
  /** `libros` = materialised VatBookEntry rows; `documentos` = derived in memory from invoices/bills/expenses (not materialised yet). */
  origen: "libros" | "documentos" | "retenciones" | "modelos_303";
  libros?: Partial<Record<VatBookName, VatBookSummary>>;
  diario?: FiscalLedgerCrossCheck;
  liquidacion?: { journalEntryId: string; entryNumber: number | null; fiscalYearCode: string | null; entryDate: string; reversed: boolean } | null;
  /** FIX-1 · F3: settlement entries imported from Sage 200 inside the period (303 only; empty when none). */
  liquidacionesHistoricas?: FiscalHistoricalSettlementDto[];
  /** FIX-1 · F3: true for the monthly informative view of a quarterly sociedad (303 only): no compensation, not filable. */
  informativo?: boolean;
  /** Number of source documents / withholding records read. */
  registros?: number;
  periodos?: Array<{ periodo: string; resultado: number }>;
};

export type FiscalPresentation = {
  modo: "manual";
  ficheroOficial: false;
  nota: string;
  /**
   * Tanda 6b (R8): the sujeto pasivo does not have to file this model (a
   * sociedad in the SII is exonerated from the 347 and the 390). The figures
   * stay informative; `motivo` is the Spanish reason shown next to the badge.
   */
  noSePresenta?: { motivo: string };
};

/**
 * Tanda 6b · L5 (design §5.2 R8): the fiscal regime of the sujeto pasivo has ONE
 * source — `LegalEntity.largeCompany` / `LegalEntity.siiEnabled`
 * (`resolveLegalIdentity`, apps/api/src/lib/finance-scope.ts). It governs the
 * effective periodicity of the 303/111/115 (monthly when either flag is set,
 * RIVA 71.3), which annual models are not filed (SII → no 347, no 390) and
 * whether VeriFactu applies (RD 1007/2023 art. 3.3 excludes SII taxpayers).
 */
export type FiscalRegimeSummary = {
  siiEnabled: boolean;
  largeCompany: boolean;
  /** Effective periodicity of the settlement models (303 · 111 · 115). */
  periodicity: VatPeriodicityCode;
  /** Periodicity stored in VatSettings (the effective one wins when the regime forces monthly). */
  persistedPeriodicity: VatPeriodicityCode;
  /** null = the stored periodicity applies; otherwise why monthly is forced. */
  periodicityForcedBy: "sii" | "large_company" | null;
  /** Models this sujeto pasivo does not file («no se presenta»). */
  modelosNoPresentados: FiscalModelCode[];
  verifactu: { aplica: boolean; motivo: string | null };
};

/**
 * Badge «Declarante · <razón social> · <NIF>» of every AEAT model and VAT book
 * (design §5.3): the sociedad behind the NIF, read through `resolveLegalIdentity`.
 * `source: organization_fallback` → the tenant has no backfilled legal entity yet
 * (the UI shows «Sociedad pendiente»). `declarante` (nif · nombre) is kept as the
 * legacy pair; this block is the typed version with the regime.
 */
export type FiscalDeclaranteBadge = {
  legalEntityId: string | null;
  code: string | null;
  legalName: string;
  taxId: string | null;
  taxIdValid: boolean;
  source: "legal_entity" | "organization_fallback";
  regimen: FiscalRegimeSummary;
};

/**
 * `GET /fiscal/regime?year=AAAA`: régimen vigente de la sociedad y propuesta al
 * cierre del ejercicio (RIVA 71.3: volumen de operaciones > 6.010.121,04 € →
 * gran empresa: 303/111/115 mensuales, SII obligatorio, sin 347/390, fuera del
 * RRSIF). The proposal never writes: the change is confirmed in Estructura
 * societaria › Datos fiscales (`organization.structure.manage`).
 */
export type FiscalRegimeProposal = {
  /** Regime the figures point to. */
  regimen: "general" | "gran_empresa";
  /** true when it differs from the flags of the legal entity. */
  cambia: boolean;
  motivo: string;
};

export type FiscalRegimeReport = {
  organizationId: string;
  year: number;
  sociedad: FiscalDeclaranteBadge;
  vatSettings: VatSettingsDto;
  /** Volumen de operaciones of the year from the 390 (bases + operaciones al 0 %); null when the books are empty. */
  volumenOperaciones: number | null;
  umbralGranEmpresa: number;
  propuesta: FiscalRegimeProposal;
  avisos: string[];
  generatedAt: string;
};

export type FiscalModelReport = {
  modelo: FiscalModelCode;
  titulo: string;
  organizationId: string;
  propertyId: string | null;
  periodo: FiscalPeriodDto;
  /** Legacy pair (nif · nombre) — always the legal entity's since Tanda 6b; see `sociedad`. */
  declarante: { nif: string | null; nombre: string | null };
  /** Tanda 6b: typed declarant badge with the fiscal regime (R8). */
  sociedad: FiscalDeclaranteBadge;
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
  /** FIX-1 · F2: régimen de la operación; null = sin clasificar. */
  regime: VatBookRegimeCode | null;
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
  /** EFFECTIVE periodicity: monthly when the legal entity is gran empresa / SII (R8), else the stored one. */
  periodicity: VatPeriodicityCode;
  regime: VatRegimeCode;
  prorrataPct: number | null;
  taxFigure: "IVA" | "IGIC" | "IPSI";
  /** FIX-1 · F3 (B-2): saldo inicial a compensar (casilla 110) arrastrado de periodos anteriores a la primera liquidación de ehotelOS; ≥ 0. */
  openingCompensation: number;
  /** FIX-1 · F3: settlement period code (`2025-Q1` · `2025-01`) from which the opening balance applies; null = never. */
  openingCompensationPeriod: string | null;
  /** false when the organisation has no row yet (defaults shown). */
  persisted: boolean;
  /** Tanda 6b: the sociedad behind the settings and its regime (the badge every fiscal screen shows). */
  sociedad: FiscalDeclaranteBadge;
};

/** FIX-1 · F3: `GET /fiscal/vat-books/periods` — the settlement periods with materialised book rows, newest first. */
export type VatBookPeriodsResponse = {
  organizationId: string;
  periods: Array<{ period: string; rows: number; lastDate: string | null }>;
  /** Period code of the newest materialised rows; null when the organisation has no book rows at all. */
  latest: string | null;
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

/**
 * FIX-1 · F2: recuento de una regla de `POST /fiscal/vat-books/reclassify` (importes en euros, ids ≤ 5 ejemplos).
 * Reglas: 1 autofacturas intracomunitarias (parejas → `aib`), 2 DUA (`importacion`), 3 ventas al 0 % con NIF
 * extranjero (`exento_no_sujeto`, solo con includeZeroRate), 4 autofacturas con inversión del sujeto pasivo
 * (parejas con NIF extranjero no intracomunitario → `isp`). `reglas[]` viene siempre en el orden 1, 2, 3, 4.
 */
export type VatBooksReclassifyRuleDto = {
  regla: 1 | 2 | 3 | 4;
  regimen: VatBookRegimeCode;
  descripcion: string;
  /** Filas que la regla clasifica = `filasEmitidas` + `filasRecibidas` (las dos caras en las reglas 1 y 4); `porPeriodo[].filas` suma lo mismo. */
  filas: number;
  filasEmitidas: number;
  filasRecibidas: number;
  /** Reglas 1 y 4: parejas autofactura ↔ recibida (= emitidas clasificadas). */
  parejas?: number;
  /** Importes de UNA cara (la emitida en las parejas; la recibida tiene los mismos), total y por periodo. */
  base: number;
  cuota: number;
  ids: string[];
  porPeriodo: Array<{ periodo: string; filas: number; base: number; cuota: number }>;
};

/**
 * FIX-1 · F2: respuesta de `POST /fiscal/vat-books/reclassify` (dry-run por defecto; el mismo objeto con
 * `apply: true` y `actualizadas` tras escribir). Solo filas `sourceType sage200` con `regime` null.
 */
export type VatBooksReclassifyResponse = {
  organizationId: string;
  apply: boolean;
  includeZeroRate: boolean;
  periodo: FiscalPeriodDto;
  /** Filas candidatas leídas (sage200, sin régimen, en el periodo). */
  candidatas: { emitidas: number; recibidas: number };
  reglas: VatBooksReclassifyRuleDto[];
  /** Emitidas sin NIF que ninguna recibida empareja (posibles autofacturas sin pareja o ventas a particulares). */
  sinPareja: { filas: number; cuota: number };
  /** Recibidas sin NIF que ni la regla 1 ni la regla 2 clasifican (tickets sin NIF…). */
  recibidasSinNifNoClasificadas: { filas: number; cuota: number };
  /** Filas escritas (0 en dry-run). */
  actualizadas: number;
  avisos: string[];
  generatedAt: string;
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
