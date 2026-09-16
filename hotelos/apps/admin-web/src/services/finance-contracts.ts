// Finanzas · Tanda 6 (lote nav-services) — pure helpers shared by the finance
// clients (accountingApi · fiscalApi · payablesApi · assetsApi · treasuryApi ·
// financialStatementsApi · cashClosureApi · payrollApi · commissionsApi):
//
//   · FINANCE_ERROR_MESSAGES — every `details.code` the finance modules answer
//     with (packages/shared/src/*-types.ts: LEDGER_ERROR_CODES,
//     PAYMENT_ERROR_CODES, PosErrorCode, PayablesErrorCode, TreasuryErrorCode,
//     fiscal and gestoría codes) → the Spanish sentence the screens show;
//   · financeErrorMessage(error) — code first, then the API message, then a
//     fallback (PSP_NOT_CONFIGURED appends `details.psp.message`,
//     PREVIOUS_PERIOD_MISSING lists `details.pendingPeriods`);
//   · query builders that mirror the zod query schemas of the routes (drop
//     empty values, booleans as "1"/"0", `envelope=1` on keyset lists);
//   · settlement-period helpers (`2026-Q3` · `2026-09` · `2026`) and the
//     `periods` parameter of the USALI period comparison (`from..to,from..to`);
//   · downloadFilename for Content-Disposition headers.
//
// No network, no React, no import.meta: services/__tests__/finance-contracts.test.mts
// runs this module under `node --test` (api-client.ts cannot load there).

import type { FiscalModelCode, JournalListQuery, PaymentLinkResponse, CapturedPaymentResponse } from "@hotelos/shared";

/** Query string shape accepted by apiRequest / apiRequestBlob. */
export type FinanceQuery = Record<string, string | number | undefined>;

// ---------------------------------------------------------------------------
// details.code → mensaje
// ---------------------------------------------------------------------------

const UNBALANCED = "El asiento no cuadra: la suma del debe tiene que ser igual a la del haber.";
const SIMPLIFIED_LIMIT = "El importe supera el límite de la factura simplificada: emite una factura completa con el NIF del cliente.";

export const FINANCE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // --- diario y plan (LEDGER_ERROR_CODES) ---
  JOURNAL_TOO_FEW_LINES: "Un asiento necesita al menos dos líneas.",
  JOURNAL_NEGATIVE_LINE: "Las líneas del asiento no admiten importes negativos: anota el importe en la columna contraria.",
  JOURNAL_LINE_SIDE: "Cada línea lleva importe en el debe o en el haber, no en ambos.",
  JOURNAL_UNBALANCED: UNBALANCED,
  ACCOUNT_CODE_INVALID: "El código de cuenta no es válido.",
  ACCOUNT_NOT_FOUND: "La cuenta no existe en el plan contable de la organización.",
  ACCOUNT_NOT_POSTABLE: "La cuenta es una cabecera del plan: elige una subcuenta imputable.",
  ACCOUNT_CODE_EXISTS: "Ya existe una cuenta con ese código.",
  JOURNAL_SOURCE_REQUIRED: "El asiento necesita el documento de origen.",
  JOURNAL_DESCRIPTION_REQUIRED: "El concepto del asiento es obligatorio.",
  FISCAL_PERIOD_CLOSED: "El periodo contable de esa fecha está cerrado: reábrelo o cambia la fecha del asiento.",
  FISCAL_YEAR_CLOSED: "El ejercicio de esa fecha está cerrado: reábrelo en Contabilidad › Cierre de ejercicio antes de asentar.",
  JOURNAL_DRAFT_NOT_REVERSIBLE: "Un borrador no se anula: se descarta.",
  JOURNAL_REVERSAL_OF_REVERSAL: "Un asiento de anulación no se puede anular de nuevo.",
  JOURNAL_REVERSAL_REASON_REQUIRED: "Indica el motivo de la anulación.",
  CHART_NOT_PROVISIONED: "La organización no tiene plan de cuentas: provisiona la plantilla PGC Pymes hotelero antes de contabilizar.",
  INVOICE_CASH_SALE_NOT_SIMPLIFIED: "Una venta al contado del punto de venta se documenta con factura simplificada.",
  // --- IVA y modelos AEAT ---
  UNKNOWN_MODEL: "Modelo no admitido: usa 303, 390, 347, 111, 115 o 180.",
  INVALID_PERIOD: "Periodo no válido: usa un trimestre (2026-Q3), un mes (2026-09) o un año (2026).",
  // --- cobros (PAYMENT_ERROR_CODES) ---
  PSP_NOT_CONFIGURED: "No hay pasarela de pago configurada: el cobro con tarjeta en línea o enlace de pago no se puede registrar.",
  PAYMENT_REQUIRES_PSP: "Este método de cobro necesita la confirmación de la pasarela de pago.",
  IDEMPOTENCY_CONFLICT: "Ya existe un cobro con la misma clave de reintento y datos distintos.",
  PAN_NOT_ACCEPTED: "No se admite el número de tarjeta en claro: usa el token de la pasarela de pago.",
  PSP_TOKEN_REQUIRED: "Falta el token de la pasarela de pago.",
  FOLIO_CHANGED_SINCE_DRAFT: "El folio ha cambiado desde que se preparó el borrador: revisa la factura antes de emitirla.",
  ISSUER_TAX_ID_SERIES_MISMATCH: "La serie de facturación pertenece a otro NIF emisor.",
  SIMPLIFIED_LIMIT_EXCEEDED: SIMPLIFIED_LIMIT,
  INVOICE_NOT_ISSUED: "La factura aún no está emitida.",
  EMAIL_DELIVERY_FAILED: "El proveedor de correo no pudo entregar el mensaje.",
  PSP_WEBHOOK_REJECTED: "La notificación de la pasarela de pago no superó la verificación de firma.",
  // --- TPV, arqueo y cierre del día (PosErrorCode) ---
  POS_TICKET_CLOSED: "La comanda ya está cerrada.",
  POS_OUTLET_NOT_FOUND: "El punto de venta no existe.",
  POS_ROOM_NOT_OCCUPIED: "La habitación no está ocupada: la comanda no se puede cargar al folio.",
  CASH_CLOSURE_CLOSED: "La caja de ese punto de venta y día ya está cerrada: no admite más ventas al contado.",
  CASH_CLOSURE_EXISTS: "Ya hay un cierre de caja para ese punto de venta y día.",
  CASH_CLOSURE_NOT_OPEN: "El cierre de caja no está abierto.",
  CASH_CLOSURE_NOT_CLOSED: "Cierra la caja antes de aprobarla.",
  CASH_COUNT_MISMATCH: "El recuento por denominaciones no coincide con el efectivo contado.",
  SIMPLIFIED_INVOICE_LIMIT: SIMPLIFIED_LIMIT,
  ACCOUNT_MISSING: "Falta una cuenta del plan necesaria para asentar la venta.",
  INVALID_DATE: "La fecha no es válida.",
  WINDOW_PARAMS_CONFLICT: "Indica una fecha o un intervalo, no ambos.",
  NIGHT_AUDIT_ALREADY_COMPLETED: "El cierre del día de esa fecha ya se ha ejecutado.",
  NIGHT_AUDIT_IN_PROGRESS: "Hay un cierre del día en curso: espera a que termine.",
  // --- proveedores, gastos e inmovilizado (PayablesErrorCode) ---
  VALIDATION_ERROR: "Revisa los datos del formulario.",
  SUPPLIER_NIF_INVALID: "El NIF o CIF del proveedor no es válido.",
  SUPPLIER_NIF_DUPLICATE: "Ya existe un proveedor con ese NIF.",
  SUPPLIER_IBAN_INVALID: "El IBAN no es válido.",
  SUPPLIER_REQUIRED: "Indica el proveedor o su nombre.",
  SUPPLIER_NIF_REQUIRED: "El NIF del proveedor es obligatorio para deducir el IVA.",
  EXPENSE_ACCOUNT_INVALID: "La cuenta de gasto debe ser una subcuenta del grupo 6 (o 20x/21x para bienes de inversión).",
  UNSUPPORTED_TAX_RATE: "Tipo de IVA no admitido: usa 21, 10, 4, 7, 3, 2 o 0.",
  LINE_QUOTA_MISMATCH: "La cuota de IVA de la línea no coincide con la base por el tipo.",
  LINE_RETENTION_MISMATCH: "La retención de la línea no coincide con la base por el porcentaje.",
  TOTAL_MISMATCH: "El total impreso no coincide con la suma de las líneas.",
  DUE_DATE_BEFORE_ISSUE: "La fecha de vencimiento no puede ser anterior a la de emisión.",
  ISSUE_DATE_REQUIRED: "Indica la fecha de emisión.",
  PAYMENT_BEFORE_ISSUE: "La fecha de pago no puede ser anterior a la de emisión.",
  COUNTER_ACCOUNT_INVALID: "La cuenta de contrapartida no es válida: usa 572, 570 o una subcuenta de 572.",
  SUPPLIER_BILL_DUPLICATE: "Ya existe una factura de ese proveedor con el mismo número.",
  INVALID_STATUS_TRANSITION: "El estado actual del documento no admite esa acción.",
  BILL_HAS_FIXED_ASSETS: "La factura tiene elementos de inmovilizado asociados: da de baja los elementos antes de anularla.",
  ATTACHMENT_INVALID: "El adjunto debe ser un PDF, JPEG o PNG.",
  ATTACHMENT_TOO_LARGE: "El adjunto supera los 512 KiB.",
  EXPENSE_VAT_NOT_DEDUCTIBLE_WITHOUT_NIF: "Sin NIF del proveedor el IVA del gasto no es deducible.",
  ASSET_CATEGORY_REQUIRED: "Indica la categoría o la cuenta del elemento.",
  ASSET_ACCOUNT_INVALID: "La cuenta del inmovilizado debe ser 20x o 21x.",
  COEFFICIENT_REQUIRED: "Indica el coeficiente de amortización.",
  COEFFICIENT_ABOVE_MAX: "El coeficiente supera el máximo de las tablas del artículo 12 de la Ley del Impuesto sobre Sociedades.",
  RESIDUAL_ABOVE_COST: "El valor residual no puede superar el coste de adquisición.",
  RESIDUAL_ABOVE_NBV: "El valor residual no puede superar el valor neto contable.",
  START_BEFORE_ACQUISITION: "La amortización no puede empezar antes de la adquisición.",
  DISPOSAL_BEFORE_ACQUISITION: "La baja no puede ser anterior a la adquisición.",
  ASSET_DISPOSED: "El elemento ya está dado de baja.",
  ASSET_NOT_CONFIGURED: "El elemento no tiene categoría, coeficiente o cuentas: complétalo antes de amortizar.",
  ASSET_HAS_DEPRECIATION: "El elemento ya tiene amortización contabilizada.",
  PERIOD_INVALID: "El periodo debe tener el formato AAAA-MM.",
  PERIOD_IN_FUTURE: "No se puede amortizar un mes futuro.",
  LATER_RUN_EXISTS: "Hay una corrida posterior contabilizada: revierte primero la más reciente.",
  PREVIOUS_PERIOD_MISSING: "Faltan meses anteriores por contabilizar: las corridas van mes a mes, sin huecos.",
  UNBALANCED_ENTRY: UNBALANCED,
  INVALID_LEDGER_LINE: "Una línea del asiento no es válida.",
  ACCOUNT_NOT_IN_CHART: "La cuenta no está en el plan contable.",
  ENTRY_ALREADY_REVERSED: "El asiento ya está anulado.",
  ENTRY_NOT_FOUND: "El asiento no existe.",
  // --- tesorería, banca, comisiones y nóminas (TreasuryErrorCode) ---
  STATEMENT_ALREADY_IMPORTED: "Ese extracto ya se había importado: no se han creado movimientos duplicados.",
  LINE_ALREADY_MATCHED: "El movimiento bancario ya está conciliado.",
  DIRECTION_MISMATCH: "El signo del movimiento bancario no coincide con el del documento.",
  AMOUNT_MISMATCH: "El importe del movimiento bancario no coincide con el del documento.",
  PAYMENT_NOT_CAPTURED: "El cobro no está capturado: no se puede conciliar.",
  SUPPLIER_BILL_NOT_POSTED: "La factura recibida no está contabilizada.",
  SUPPLIER_BILL_AMOUNT_MISMATCH: "El importe de la factura recibida no coincide con el movimiento bancario.",
  REMITTANCE_STATUS_TRANSITION: "El estado de la remesa no admite ese cambio.",
  REMITTANCE_EMPTY: "La remesa no tiene operaciones.",
  COMMISSION_NOT_ACCRUED: "La comisión no está devengada.",
  COMMISSION_SETTLED: "La comisión ya está liquidada.",
  PAYROLL_PERIOD_EXISTS: "Ya existe un periodo de nómina con ese código.",
  PAYROLL_PERIOD_CLOSED: "El periodo de nómina está cerrado.",
  PAYROLL_PERIOD_PAID: "El periodo de nómina ya está pagado.",
  PAYROLL_PERIOD_NOT_CALCULATED: "Calcula el periodo de nómina antes de exportarlo o pagarlo.",
  PAYROLL_NOTHING_TO_PAY: "El periodo de nómina no tiene importe neto que pagar.",
  // --- estados y gestoría ---
  EXPORT_FORMAT_NOT_IMPLEMENTED: "Ese formato de exportación aún no está disponible: usa el CSV universal de asientos.",
  USALI_LINE_NOT_ADMITTED: "La línea no se admite en ese departamento USALI.",
  SNAPSHOT_NOT_FOUND: "No existe esa instantánea de los estados contables."
});

export const FINANCE_ERROR_FALLBACK = "No se pudo completar la operación. Inténtalo de nuevo.";

type ErrorLike = { message?: unknown; details?: unknown; status?: unknown };

function asErrorLike(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : null;
}

/** `details.code` of a typed 4xx (ApiError or any `{ details: { code } }`), or null. */
export function financeErrorCode(error: unknown): string | null {
  const details = financeErrorDetails(error);
  const code = details?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** `details` object of a typed 4xx, or null. */
export function financeErrorDetails(error: unknown): Record<string, unknown> | null {
  const details = asErrorLike(error)?.details;
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : null;
}

/** HTTP status of an ApiError-like error, or null. */
export function financeErrorStatus(error: unknown): number | null {
  const status = asErrorLike(error)?.status;
  return typeof status === "number" ? status : null;
}

export function hasFinanceErrorCode(error: unknown, code: string): boolean {
  return financeErrorCode(error) === code;
}

/**
 * Spanish message for a finance error: the dictionary sentence of
 * `details.code` (with the PSP note or the pending months when the API sends
 * them), otherwise the API message, otherwise `fallback`.
 */
export function financeErrorMessage(error: unknown, fallback: string = FINANCE_ERROR_FALLBACK): string {
  const code = financeErrorCode(error);
  const details = financeErrorDetails(error);
  if (code && FINANCE_ERROR_MESSAGES[code]) {
    const base = FINANCE_ERROR_MESSAGES[code];
    if (code === "PSP_NOT_CONFIGURED") {
      const psp = details?.psp;
      const note = typeof psp === "object" && psp !== null ? (psp as { message?: unknown }).message : undefined;
      return typeof note === "string" && note.trim() ? `${base} ${note.trim()}` : base;
    }
    if (code === "PREVIOUS_PERIOD_MISSING") {
      const pending = details?.pendingPeriods;
      return Array.isArray(pending) && pending.length > 0 ? `${base} Contabiliza antes: ${pending.map(String).join(", ")}.` : base;
    }
    return base;
  }
  const message = asErrorLike(error)?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

// ---------------------------------------------------------------------------
// Query builders (mirror the zod query schemas: unknown keys are 400)
// ---------------------------------------------------------------------------

/** Drop undefined / null / "" values; booleans travel as "1" / "0" (accepted by every flag schema of the finance routes). */
export function compactQuery(input: Record<string, string | number | boolean | null | undefined>): FinanceQuery {
  const out: FinanceQuery = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "boolean" ? (value ? "1" : "0") : value;
  }
  return out;
}

/** GET /accounting/journal — always `envelope=1` so the answer is `{ items, nextCursor, total }`. */
export function journalQuery(query: JournalListQuery = {}): FinanceQuery {
  return compactQuery({
    from: query.from,
    to: query.to,
    propertyId: query.propertyId,
    sourceType: query.sourceType,
    status: query.status,
    accountCode: query.accountCode,
    q: query.q,
    limit: query.limit,
    cursor: query.cursor ?? undefined,
    envelope: "1"
  });
}

export type LedgerQueryInput = { from?: string; to?: string; propertyId?: string };

/** GET /accounting/ledger/:accountCode (`format=csv` only through downloadLedgerCsv). */
export function ledgerQuery(query: LedgerQueryInput = {}, format?: "json" | "csv"): FinanceQuery {
  return compactQuery({ from: query.from, to: query.to, propertyId: query.propertyId, format });
}

/** GET /accounting/chart — `postableOnly` for account pickers (headers excluded). */
export function chartQuery(options: { postableOnly?: boolean } = {}): FinanceQuery {
  return compactQuery({ postableOnly: options.postableOnly });
}

// ---- fiscal -----------------------------------------------------------------

/** Annual models take `year=AAAA`; the rest take a settlement `period`. */
export const ANNUAL_FISCAL_MODELS: readonly FiscalModelCode[] = ["390", "347", "180"];

export function isAnnualFiscalModel(modelo: FiscalModelCode | string): boolean {
  return (ANNUAL_FISCAL_MODELS as readonly string[]).includes(modelo);
}

export type FiscalModelParams = {
  /** `2026-Q3` · `2026-09` (periodic models) or `2026` (annual models). */
  period?: string;
  year?: number | string;
  propertyId?: string;
  fromDate?: string;
  toDate?: string;
  periodType?: "monthly" | "quarterly";
};

/** GET /fiscal/models/:modelo — annual models get `year` (derived from `period` when only that is given). */
export function fiscalModelQuery(modelo: FiscalModelCode | string, params: FiscalModelParams = {}): FinanceQuery {
  if (isAnnualFiscalModel(modelo)) {
    const year = params.year ?? (params.period && /^\d{4}/.test(params.period) ? params.period.slice(0, 4) : undefined);
    return compactQuery({ year: year === undefined ? undefined : String(year), propertyId: params.propertyId });
  }
  return compactQuery({ period: params.period, propertyId: params.propertyId, fromDate: params.fromDate, toDate: params.toDate, periodType: params.periodType });
}

export type VatBookQueryInput = { book: "emitidas" | "recibidas" | "bienes_inversion"; period?: string; from?: string; to?: string; propertyId?: string };

/** GET /fiscal/vat-books */
export function vatBookQuery(input: VatBookQueryInput): FinanceQuery {
  return compactQuery({ book: input.book, period: input.period, from: input.from, to: input.to, propertyId: input.propertyId });
}

// ---- periods ----------------------------------------------------------------

function toUtcDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  return new Date(day);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-Q3` of a calendar day (UTC). */
export function quarterPeriod(value: Date | string): string {
  const date = toUtcDate(value);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

/** `2026-09` of a calendar day (UTC). */
export function monthPeriod(value: Date | string): string {
  const date = toUtcDate(value);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

/** `2026` of a calendar day (UTC). */
export function yearPeriod(value: Date | string): string {
  return String(toUtcDate(value).getUTCFullYear());
}

export type PeriodBounds = { code: string; type: "quarterly" | "monthly" | "annual"; from: string; to: string };

/** Inclusive calendar bounds of a settlement period code, or null when the code is not `AAAA-Qn` · `AAAA-MM` · `AAAA`. */
export function periodBounds(code: string): PeriodBounds | null {
  const trimmed = code.trim();
  const quarter = /^(\d{4})-Q([1-4])$/.exec(trimmed);
  if (quarter) {
    const year = Number(quarter[1]);
    const q = Number(quarter[2]);
    const firstMonth = (q - 1) * 3 + 1;
    const lastDay = new Date(Date.UTC(year, firstMonth + 2, 0)).getUTCDate();
    return { code: trimmed, type: "quarterly", from: `${year}-${pad2(firstMonth)}-01`, to: `${year}-${pad2(firstMonth + 2)}-${pad2(lastDay)}` };
  }
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(trimmed);
  if (month) {
    const year = Number(month[1]);
    const m = Number(month[2]);
    const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return { code: trimmed, type: "monthly", from: `${year}-${pad2(m)}-01`, to: `${year}-${pad2(m)}-${pad2(lastDay)}` };
  }
  const year = /^(\d{4})$/.exec(trimmed);
  if (year) return { code: trimmed, type: "annual", from: `${year[1]}-01-01`, to: `${year[1]}-12-31` };
  return null;
}

/** Previous settlement period of the same type (`2026-Q1` → `2025-Q4`, `2026-01` → `2025-12`, `2026` → `2025`). */
export function previousPeriod(code: string): string | null {
  const bounds = periodBounds(code);
  if (!bounds) return null;
  const from = toUtcDate(bounds.from);
  if (bounds.type === "quarterly") return quarterPeriod(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 3, 1)));
  if (bounds.type === "monthly") return monthPeriod(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1)));
  return String(from.getUTCFullYear() - 1);
}

// ---- estados financieros ----------------------------------------------------

export type StatementWindow = { from?: string; to?: string; propertyId?: string };
export type StatementDownloadFormat = "json" | "pdf" | "xlsx" | "csv";

/** GET /accounting/usali/pnl · /mappings · /coverage */
export function statementWindowQuery(window: StatementWindow = {}, format?: StatementDownloadFormat): FinanceQuery {
  return compactQuery({ from: window.from, to: window.to, propertyId: window.propertyId, format });
}

/** `periods=2026-01-01..2026-03-31,2026-04-01..2026-06-30` of GET /accounting/usali/periods (the first one is the base). */
export function usaliPeriodsParam(periods: ReadonlyArray<{ from: string; to: string }>): string {
  return periods.map((period) => `${period.from}..${period.to}`).join(",");
}

export type AnnualAccountsQueryInput = StatementWindow & { fiscalYearId?: string; comparative?: boolean };

/** GET /accounting/annual-accounts[/balance|/pyg|/ecpn|/memoria] */
export function annualAccountsQuery(input: AnnualAccountsQueryInput = {}, format?: StatementDownloadFormat): FinanceQuery {
  return compactQuery({ fiscalYearId: input.fiscalYearId, from: input.from, to: input.to, propertyId: input.propertyId, comparative: input.comparative, format });
}

// ---- proveedores, gastos e inmovilizado -------------------------------------

export type SupplierListInput = { q?: string; active?: boolean; limit?: number };
export function supplierListQuery(input: SupplierListInput = {}): FinanceQuery {
  // The route's boolQuery accepts "true" | "false" | "1" | "0".
  return compactQuery({ q: input.q, active: input.active === undefined ? undefined : input.active ? "true" : "false", limit: input.limit });
}

export type SupplierBillListInput = { status?: "draft" | "approved" | "posted" | "paid" | "cancelled"; supplierId?: string; from?: string; to?: string; dueBefore?: string; q?: string; limit?: number };
export function supplierBillListQuery(input: SupplierBillListInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, supplierId: input.supplierId, from: input.from, to: input.to, dueBefore: input.dueBefore, q: input.q, limit: input.limit });
}

export type ExpenseListInput = { from?: string; to?: string; paidWith?: "cash" | "card" | "bank"; includeCancelled?: boolean; q?: string; limit?: number };
export function expenseListQuery(input: ExpenseListInput = {}): FinanceQuery {
  return compactQuery({ from: input.from, to: input.to, paidWith: input.paidWith, includeCancelled: input.includeCancelled, q: input.q, limit: input.limit });
}

export type FixedAssetListInput = { status?: "active" | "fully_depreciated" | "disposed"; q?: string; limit?: number };
export function fixedAssetListQuery(input: FixedAssetListInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, q: input.q, limit: input.limit });
}

// ---- tesorería ----------------------------------------------------------------

export type TreasuryScope = { propertyId?: string; asOf?: string };
export function treasuryScopeQuery(scope: TreasuryScope = {}): FinanceQuery {
  return compactQuery({ propertyId: scope.propertyId, asOf: scope.asOf });
}

// ---- TPV y arqueo -----------------------------------------------------------

export type PosTicketsInput = { status?: "open" | "closed" | "all"; closedFrom?: string; limit?: number };
export function posTicketsQuery(input: PosTicketsInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, closedFrom: input.closedFrom, limit: input.limit });
}

export type CashClosureListInput = { status?: "open" | "closed" | "approved"; outletId?: string; from?: string; to?: string; limit?: number };
export function cashClosureListQuery(input: CashClosureListInput = {}): FinanceQuery {
  return compactQuery({ status: input.status, outletId: input.outletId, from: input.from, to: input.to, limit: input.limit });
}

// ---------------------------------------------------------------------------
// Cobros: resultado de POST /folios/:id/payments
// ---------------------------------------------------------------------------

export type FolioPaymentResult = CapturedPaymentResponse | PaymentLinkResponse;

/** 202: the PSP must confirm; open `redirect` (GET url or POST form) — nothing is «cobrado» yet. */
export function isPaymentIntent(result: FolioPaymentResult): result is PaymentLinkResponse {
  return result.kind === "payment_intent";
}

/** 201 / 200: a captured payment (cash · card_terminal · bank_transfer · other). */
export function isCapturedPayment(result: FolioPaymentResult): result is CapturedPaymentResponse {
  return result.kind === "payment";
}

/** Idempotency key of a payment attempt (reused on retries of the same attempt). */
export function newClientRequestId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Descargas
// ---------------------------------------------------------------------------

/** File name of a `Content-Disposition` header (`filename*=UTF-8''…` wins over `filename="…"`), or `fallback`. */
export function downloadFilename(contentDisposition: string | null | undefined, fallback: string): string {
  if (!contentDisposition) return fallback;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(contentDisposition);
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
      if (decoded) return decoded;
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/.exec(contentDisposition);
  const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return name || fallback;
}
