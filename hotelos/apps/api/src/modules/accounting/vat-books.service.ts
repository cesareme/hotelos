// Finanzas · lote «iva-modelos» — Libros registro de IVA (RD 1619/2012 art. 62
// RIVA: emitidas, recibidas, bienes de inversión).
//
// Contract (docs/runbooks/finanzas-contabilidad.md §1.4): `VatBookEntry` is ONE
// row per document AND tax rate, unique by (organizationId, book, sourceType,
// sourceId, rate), and it is the single source of the Modelo 303 / 390 / 347.
// The emitidas rows are written LIVE by the invoicing module in the same
// transaction that issues / rectifies / cancels an invoice
// (`invoicing/vat-book.ts` writeIssuedVatBookRows, called from
// invoice.service.ts); the suppliers lot writes the recibidas /
// bienes_inversion rows when a bill is posted or an expense is registered
// (`payables/vat-book.ts`). This module offers:
//   · the PURE row builders (`vatRowsFromInvoice`, `vatRowsFromSupplierBill`,
//     `vatRowsFromExpense`) that derive the SAME rows the live writers
//     materialise, so a rebuild and the live book always agree;
//   · `rebuildVatBooks` — materialises a date range from the documents
//     (invoices, supplier bills, expenses) of the organisation, keeping the
//     rows imported from Sage 200 (`sourceType sage200`, Tanda 7c);
//   · `loadVatBookRows` — what the models read: the materialised rows of a
//     book when they exist for the range, otherwise the SAME rows derived in
//     memory from the documents (flagged `origen: "documentos"` + aviso), so
//     Faranda gets a real 303 today without a single write;
//   · `registerSupplierBillInVatBooks` / `registerExpenseInVatBooks` — the
//     in-transaction writers of the payables side (idempotent: delete + insert
//     by source key). The invoice counterparts (`registerInvoiceInVatBooks`,
//     `registerInvoiceCancellationInVatBooks`) were retired in Tanda L3-C: the
//     emitidas book has ONE live writer (invoicing/vat-book.ts).
//
// Money: Prisma.Decimal everywhere, rounded to 2 decimals per group (the same
// per-group rounding as computeInvoiceTotals, contract B of Tanda 3: base =
// round2(gross / (1 + t)), quota = round2(gross − base)); never floats.
// Rectificativas carry NEGATIVE base/quota in the book (the ledger posts the
// inverse entry with positive amounts instead).
//
// sourceId convention of the counter-rows (Tanda L3-C, ONE convention shared
// with the live writer in invoice.service.ts — `VatBookSourceType` has no
// `cancellation` value, so the document id carries a suffix):
//   · `<invoiceId>#anulacion`  — negating rows of a cancelled invoice (VeriFactu
//     RegistroAnulacion), dated on the cancellation day (Europe/Madrid);
//   · `<invoiceId>#sustituida` — negating rows of an invoice replaced by a
//     rectificativa por sustitución («S»), dated on the substitute's issue day
//     (the substitute posts its own full rows under its own id), so the book
//     nets like the ledger (original reversed + substitute posted);
//   · `<expenseId>#anulacion`  — negating row of a cancelled expense.
// The pre-L3 convention `<id>:anulacion` (rebuilds before 2026-09-18) is LEGACY:
// `rebuildVatBooks` and `replaceRows` purge it so a live `#` row and a derived
// `:` row never coexist (that would count the cancellation twice).

import { Prisma } from "@prisma/client";
import { BRAND } from "../../lib/brand.js";
import { prisma } from "@hotelos/database";
import { parseTaxBreakdown, VERIFACTU_EXCLUDED_BY_SII_MOTIVO } from "@hotelos/compliance";
import { SAGE_NO_CENTRE_AVISO } from "@hotelos/shared";
import type {
  FiscalDeclaranteBadge,
  FiscalModelCode,
  FiscalPeriodDto,
  FiscalPeriodType,
  FiscalRegimeSummary,
  VatBookName,
  VatBookPeriodsResponse,
  VatBookRegimeCode,
  VatBookResponse,
  VatBookRowDto,
  VatBookSourceTypeCode,
  VatBookSummary,
  VatBooksRebuildResponse,
  VatPeriodicityCode,
  VatRegimeCode,
  VatSettingsDto
} from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { resolveLegalIdentity, type LegalIdentity } from "../../lib/finance-scope.js";
import { BadRequestError, ConflictError } from "../../lib/http-error.js";
import { buildPage, decodeCursor } from "../../lib/pagination.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";

// ── Money helpers (Decimal, 2 decimals, half away from zero) ────────────────

export type Money = Prisma.Decimal;

export const ZERO: Money = new Prisma.Decimal(0);

/** Decimal from anything Prisma or the wire hands us (null/undefined → 0). */
export function money(value: Prisma.Decimal | string | number | null | undefined): Money {
  if (value === null || value === undefined) return ZERO;
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value);
}

/** Round to cents, half away from zero (same convention as roundMoney of contract B). */
export function round2(value: Money): Money {
  const rounded = value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? ZERO : rounded;
}

export function sumMoney(values: Iterable<Money>): Money {
  let total = ZERO;
  for (const value of values) total = total.plus(value);
  return total;
}

/** Wire representation: number with 2 decimals (computed in Decimal, rounded once). */
export function toWire(value: Money): number {
  return Number(round2(value).toFixed(2));
}

/** True when |a − b| > 0.005 (a difference the cent rounding cannot explain). */
export function differs(a: Money, b: Money): boolean {
  return a.minus(b).abs().greaterThan(new Prisma.Decimal("0.005"));
}

// ── Calendar helpers ────────────────────────────────────────────────────────

const MADRID_TZ = "Europe/Madrid";
const madridFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: MADRID_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Calendar day (YYYY-MM-DD) of a timestamp in Europe/Madrid (issue / cancellation instants). */
export function madridDay(date: Date): string {
  return madridFormatter.format(date);
}

/** Calendar day of a Prisma `@db.Date` value (stored at UTC midnight). */
export function dateColumnDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Prisma value for a `@db.Date` column. */
export function dateColumn(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00.000Z`);
}

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function lastDayOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  return `${year}-${pad2(month)}-${pad2(last.getUTCDate())}`;
}

// ── Settlement periods ──────────────────────────────────────────────────────

const QUARTER_RE = /^(\d{4})-Q([1-4])$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^(\d{4})$/;

function assertYear(year: number): void {
  if (year < 2000 || year > 2100) {
    throw new BadRequestError("El periodo debe estar entre los años 2000 y 2100.");
  }
}

function quarterPeriod(year: number, quarter: 1 | 2 | 3 | 4): FiscalPeriodDto {
  const firstMonth = (quarter - 1) * 3 + 1;
  return {
    code: `${year}-Q${quarter}`,
    type: "quarterly",
    year,
    quarter,
    month: null,
    from: `${year}-${pad2(firstMonth)}-01`,
    to: lastDayOfMonth(year, firstMonth + 2),
    aeatPeriod: `${quarter}T`
  };
}

function monthPeriod(year: number, month: number): FiscalPeriodDto {
  return {
    code: `${year}-${pad2(month)}`,
    type: "monthly",
    year,
    quarter: (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4,
    month,
    from: `${year}-${pad2(month)}-01`,
    to: lastDayOfMonth(year, month),
    aeatPeriod: pad2(month)
  };
}

export function annualPeriod(year: number): FiscalPeriodDto {
  assertYear(year);
  return { code: String(year), type: "annual", year, quarter: null, month: null, from: `${year}-01-01`, to: `${year}-12-31`, aeatPeriod: "0A" };
}

/**
 * Parse `2026-Q3` / `2026-09` / `2026`. `allowed` restricts the accepted
 * kinds (a 303 never takes a year; a 390 only takes a year). Throws 400
 * `INVALID_PERIOD` in Spanish.
 */
export function parseFiscalPeriod(code: unknown, allowed: readonly FiscalPeriodType[] = ["quarterly", "monthly", "annual"]): FiscalPeriodDto {
  const invalid = (): never => {
    const error = new BadRequestError(
      `El parámetro period no es válido: usa ${allowed
        .map((kind) => (kind === "quarterly" ? "AAAA-Qn (trimestre, p. ej. 2026-Q3)" : kind === "monthly" ? "AAAA-MM (mes, p. ej. 2026-09)" : "AAAA (ejercicio, p. ej. 2026)"))
        .join(" o ")}.`
    );
    error.details = { code: "INVALID_PERIOD", allowed };
    throw error;
  };
  if (typeof code !== "string") return invalid();
  const trimmed = code.trim().toUpperCase();
  let match = QUARTER_RE.exec(trimmed);
  if (match) {
    if (!allowed.includes("quarterly")) return invalid();
    const year = Number(match[1]);
    assertYear(year);
    return quarterPeriod(year, Number(match[2]) as 1 | 2 | 3 | 4);
  }
  match = MONTH_RE.exec(trimmed);
  if (match) {
    if (!allowed.includes("monthly")) return invalid();
    const year = Number(match[1]);
    assertYear(year);
    return monthPeriod(year, Number(match[2]));
  }
  match = YEAR_RE.exec(trimmed);
  if (match) {
    if (!allowed.includes("annual")) return invalid();
    return annualPeriod(Number(match[1]));
  }
  return invalid();
}

/** Period of a calendar day under the organisation's periodicity. */
export function fiscalPeriodForDate(isoDay: string, periodicity: VatPeriodicityCode): FiscalPeriodDto {
  const year = Number(isoDay.slice(0, 4));
  const month = Number(isoDay.slice(5, 7));
  return periodicity === "monthly" ? monthPeriod(year, month) : quarterPeriod(year, (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4);
}

export function periodCodeForDate(isoDay: string, periodicity: VatPeriodicityCode): string {
  return fiscalPeriodForDate(isoDay, periodicity).code;
}

export function quarterOfDay(isoDay: string): 1 | 2 | 3 | 4 {
  return (Math.floor((Number(isoDay.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;
}

/** The period whose bounds are exactly `from..to` (a natural quarter, month or year); null otherwise. */
export function periodFromRange(from: string, to: string): FiscalPeriodDto | null {
  if (!isIsoDay(from) || !isIsoDay(to)) return null;
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7));
  if (!from.endsWith("-01")) return null;
  if (year < 2000 || year > 2100) return null;
  const monthly = monthPeriod(year, month);
  if (monthly.to === to) return monthly;
  if ((month - 1) % 3 === 0) {
    const quarterly = quarterPeriod(year, (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4);
    if (quarterly.to === to) return quarterly;
  }
  if (month === 1 && to === `${year}-12-31`) return annualPeriod(year);
  return null;
}

/** All settlement periods of a year under a periodicity (4 quarters or 12 months). */
export function periodsOfYear(year: number, periodicity: VatPeriodicityCode): FiscalPeriodDto[] {
  assertYear(year);
  if (periodicity === "monthly") return Array.from({ length: 12 }, (_, index) => monthPeriod(year, index + 1));
  return [1, 2, 3, 4].map((quarter) => quarterPeriod(year, quarter as 1 | 2 | 3 | 4));
}

// ── VAT settings ────────────────────────────────────────────────────────────

type VatSettingsClient = Pick<Prisma.TransactionClient, "vatSettings">;

const DEFAULT_SETTINGS = {
  periodicity: "quarterly" as VatPeriodicityCode,
  regime: "general" as VatRegimeCode,
  prorrataPct: null as number | null,
  taxFigure: "IVA" as const,
  // FIX-1 · F3 (B-2): no opening balance to offset until the sociedad saves one.
  openingCompensation: 0,
  openingCompensationPeriod: null as string | null
};

// ── Régimen del sujeto pasivo (Tanda 6b · L5 · design §5.2 R8) ──────────────
//
// ONE source: `LegalEntity.largeCompany` / `LegalEntity.siiEnabled` read through
// `resolveLegalIdentity`. Together they force the monthly periodicity of the
// 303 / 111 / 115 (RIVA 71.3), mark the 347 and the 390 «no se presenta» (a
// SII taxpayer is exonerated: RIVA 71.1 and RD 1065/2007 art. 32.e) and switch
// VeriFactu off with the reason (RD 1007/2023 art. 3.3 excludes the SII from
// the RRSIF). The SII itself (sending the books) is NOT built: the UI says so.
// `PropertyComplianceSetting.siiEnabled` is deprecated and never read here.

/** RIVA 71.3: volumen de operaciones of the previous year above which the sujeto pasivo is «gran empresa» (mensual, SII). */
export const LARGE_COMPANY_THRESHOLD: Money = new Prisma.Decimal("6010121.04");

/**
 * Single source of the sentence: `@hotelos/compliance` (spain/verifactu/submitter.ts),
 * the same one the invoice warning, the PDF and the retired submission row print.
 * Re-exported so the fiscal readers keep importing it from here.
 */
export { VERIFACTU_EXCLUDED_BY_SII_MOTIVO };

export function siiModelNotFiledMotivo(modelo: FiscalModelCode): string {
  return `Sociedad acogida al SII: el Modelo ${modelo} no se presenta (RIVA art. 71.1 · RD 1065/2007 art. 32.e). Las cifras se muestran a título informativo.`;
}

export type RegimeIdentity = Pick<LegalIdentity, "siiEnabled" | "largeCompany">;

/** Pure: the effective regime of a sujeto pasivo from the legal entity flags and the stored periodicity. */
export function resolveFiscalRegime(identity: RegimeIdentity, persistedPeriodicity: VatPeriodicityCode): FiscalRegimeSummary {
  const forcedBy: FiscalRegimeSummary["periodicityForcedBy"] = identity.siiEnabled ? "sii" : identity.largeCompany ? "large_company" : null;
  return {
    siiEnabled: identity.siiEnabled,
    largeCompany: identity.largeCompany,
    periodicity: forcedBy ? "monthly" : persistedPeriodicity,
    persistedPeriodicity,
    periodicityForcedBy: forcedBy,
    modelosNoPresentados: identity.siiEnabled ? ["347", "390"] : [],
    verifactu: identity.siiEnabled ? { aplica: false, motivo: VERIFACTU_EXCLUDED_BY_SII_MOTIVO } : { aplica: true, motivo: null }
  };
}

/** Pure: the declarant badge every model / book / settings response carries. */
export function declaranteBadge(identity: LegalIdentity, persistedPeriodicity: VatPeriodicityCode): FiscalDeclaranteBadge {
  return {
    legalEntityId: identity.legalEntityId,
    code: identity.code,
    legalName: identity.legalName,
    taxId: identity.taxId,
    taxIdValid: identity.taxIdValid,
    source: identity.source,
    regimen: resolveFiscalRegime(identity, persistedPeriodicity)
  };
}

/** Legacy `declarante` pair of the reports, derived from the badge (never from Organization columns). */
export function declarantePair(badge: FiscalDeclaranteBadge): { nif: string | null; nombre: string | null } {
  return { nif: badge.taxId, nombre: badge.legalName || null };
}

/**
 * Pure: the Spanish warnings a report carries because of the regime.
 * `settlement` models (303 · 111 · 115) explain the forced periodicity;
 * every model of a SII taxpayer states what is not filed and that VeriFactu
 * does not apply.
 */
export function regimeAvisos(regimen: FiscalRegimeSummary, modelo: FiscalModelCode): string[] {
  const avisos: string[] = [];
  const settlementModel = modelo === "303" || modelo === "111" || modelo === "115";
  if (settlementModel && regimen.periodicityForcedBy && regimen.persistedPeriodicity !== "monthly") {
    avisos.push(
      regimen.periodicityForcedBy === "sii"
        ? `Sociedad acogida al SII: el Modelo ${modelo} se autoliquida mensualmente (RIVA art. 71.3); la periodicidad trimestral guardada en los ajustes de IVA no se aplica.`
        : `Sociedad calificada como gran empresa: el Modelo ${modelo} se autoliquida mensualmente (RIVA art. 71.3); la periodicidad trimestral guardada en los ajustes de IVA no se aplica.`
    );
  }
  if (regimen.siiEnabled) {
    avisos.push(`Sociedad en SII: los Modelos 347 y 390 no se presentan y VeriFactu no aplica (RD 1007/2023 art. 3.3). El envío de los libros al SII no está construido en ${BRAND.name}: se declara en la interfaz.`);
  }
  return avisos;
}

/** Badge of a tenant whose organisation row is missing (contexts assembled outside Prisma): never throws. */
function pendingBadge(persistedPeriodicity: VatPeriodicityCode): FiscalDeclaranteBadge {
  return declaranteBadge(
    {
      legalEntityId: null,
      organizationId: "",
      code: null,
      legalName: "Sociedad pendiente",
      taxId: null,
      taxIdValid: false,
      source: "organization_fallback",
      legalForm: null,
      fiscalAddress: null,
      fiscalPostalCode: null,
      fiscalMunicipality: null,
      fiscalIneCode: null,
      fiscalProvince: null,
      pgcVariant: "pymes",
      largeCompany: false,
      siiEnabled: false,
      verifactuChainScope: "per_center",
      cccPrincipal: null
    },
    persistedPeriodicity
  );
}

type VatSettingsRow = { periodicity: string; regime: string; prorrataPct: Prisma.Decimal | null; taxFigure: string; openingCompensation: Prisma.Decimal; openingCompensationPeriod: string | null };

function settingsDto(organizationId: string, row: VatSettingsRow | null, identity: LegalIdentity | null): VatSettingsDto {
  const persistedPeriodicity: VatPeriodicityCode = row?.periodicity === "monthly" ? "monthly" : "quarterly";
  const sociedad = identity ? declaranteBadge(identity, persistedPeriodicity) : pendingBadge(persistedPeriodicity);
  if (!row) return { organizationId, ...DEFAULT_SETTINGS, periodicity: sociedad.regimen.periodicity, persisted: false, sociedad };
  const figure = row.taxFigure === "IGIC" || row.taxFigure === "IPSI" ? row.taxFigure : "IVA";
  return {
    organizationId,
    periodicity: sociedad.regimen.periodicity,
    regime: row.regime === "redeme" || row.regime === "recargo" ? row.regime : "general",
    prorrataPct: row.prorrataPct === null ? null : toWire(row.prorrataPct),
    taxFigure: figure,
    openingCompensation: toWire(money(row.openingCompensation)),
    openingCompensationPeriod: row.openingCompensationPeriod,
    persisted: true,
    sociedad
  };
}

/**
 * Read-only: the organisation's settings or the defaults (quarterly · general ·
 * IVA) with the sociedad badge. `periodicity` is the EFFECTIVE one: monthly
 * when the legal entity is gran empresa / SII (R8), whatever the row says.
 * Never writes.
 */
export async function getVatSettings(organizationId: string, client: VatSettingsClient = prisma): Promise<VatSettingsDto> {
  const [row, identity] = await Promise.all([client.vatSettings.findUnique({ where: { organizationId } }), resolveLegalIdentity(organizationId)]);
  return settingsDto(organizationId, row, identity);
}

/** Creates the default row on first use (contract §1.4). Only called by writers (rebuild, settlement, PUT settings). */
export async function ensureVatSettings(organizationId: string, client: VatSettingsClient = prisma): Promise<VatSettingsDto> {
  const [existing, identity] = await Promise.all([client.vatSettings.findUnique({ where: { organizationId } }), resolveLegalIdentity(organizationId)]);
  if (existing) return settingsDto(organizationId, existing, identity);
  const created = await client.vatSettings.create({ data: { organizationId } });
  return settingsDto(organizationId, created, identity);
}

export type VatSettingsPatch = Partial<Pick<VatSettingsDto, "periodicity" | "regime" | "prorrataPct" | "taxFigure" | "openingCompensation" | "openingCompensationPeriod">>;

/**
 * FIX-1 · F3 (B-2): the opening balance to offset (casilla 110) and the period it applies from.
 * Pure: `undefined` keeps the stored value; the amount must be ≥ 0 and the period a settlement
 * code (`2025-Q1` · `2025-01`, normalised) or null; an amount > 0 needs a period. Throws 400.
 */
export function resolveOpeningCompensationPatch(
  patch: Pick<VatSettingsPatch, "openingCompensation" | "openingCompensationPeriod">,
  current: Pick<VatSettingsDto, "openingCompensation" | "openingCompensationPeriod">
): { openingCompensation: Prisma.Decimal; openingCompensationPeriod: string | null } {
  const amount = patch.openingCompensation === undefined ? new Prisma.Decimal(current.openingCompensation) : new Prisma.Decimal(patch.openingCompensation);
  if (!amount.isFinite() || amount.lessThan(0)) {
    const error = new BadRequestError("El saldo inicial a compensar (casilla 110) debe ser un importe mayor o igual que 0.");
    error.details = { code: "OPENING_COMPENSATION_INVALID" };
    throw error;
  }
  let period: string | null;
  if (patch.openingCompensationPeriod === undefined) period = current.openingCompensationPeriod;
  else if (patch.openingCompensationPeriod === null || patch.openingCompensationPeriod.trim() === "") period = null;
  else period = parseFiscalPeriod(patch.openingCompensationPeriod, ["quarterly", "monthly"]).code;
  if (amount.greaterThan(0) && period === null) {
    const error = new BadRequestError("Indica el periodo desde el que aplica el saldo inicial a compensar (p. ej. 2025-Q1).");
    error.details = { code: "OPENING_COMPENSATION_PERIOD_REQUIRED" };
    throw error;
  }
  return { openingCompensation: round2(amount), openingCompensationPeriod: period };
}

export async function updateVatSettings(input: { context: UserContext; patch: VatSettingsPatch; correlationId?: string }): Promise<VatSettingsDto> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const before = await ensureVatSettings(organizationId);
  const regimen = before.sociedad.regimen;
  const opening = resolveOpeningCompensationPatch(input.patch, before);
  // The stored periodicity is the default (never the forced effective one: the regime is not written back).
  const periodicity = input.patch.periodicity ?? regimen.persistedPeriodicity;
  const regime = input.patch.regime ?? before.regime;
  if (regimen.periodicityForcedBy && periodicity !== "monthly") {
    throw new ConflictError(
      regimen.periodicityForcedBy === "sii"
        ? "Sociedad acogida al SII: la periodicidad del IVA es mensual (RIVA art. 71.3) y se gobierna desde Estructura societaria › Datos fiscales."
        : "Sociedad calificada como gran empresa: la periodicidad del IVA es mensual (RIVA art. 71.3) y se gobierna desde Estructura societaria › Datos fiscales.",
      { code: "PERIODICITY_FORCED_BY_REGIME", forcedBy: regimen.periodicityForcedBy, legalEntityId: before.sociedad.legalEntityId }
    );
  }
  if (regime === "redeme" && periodicity !== "monthly") {
    throw new ConflictError("El régimen REDEME (devolución mensual) exige periodicidad mensual del Modelo 303.", { code: "REDEME_REQUIRES_MONTHLY" });
  }
  if (input.patch.prorrataPct !== undefined && input.patch.prorrataPct !== null && (input.patch.prorrataPct < 0 || input.patch.prorrataPct > 100)) {
    throw new BadRequestError("La prorrata debe estar entre 0 y 100 (porcentaje) o ser nula para deducción íntegra.");
  }
  const updated = await prisma.vatSettings.update({
    where: { organizationId },
    data: {
      periodicity,
      regime,
      ...(input.patch.prorrataPct !== undefined ? { prorrataPct: input.patch.prorrataPct === null ? null : new Prisma.Decimal(input.patch.prorrataPct) } : {}),
      ...(input.patch.taxFigure ? { taxFigure: input.patch.taxFigure } : {}),
      ...(input.patch.openingCompensation !== undefined || input.patch.openingCompensationPeriod !== undefined ? opening : {})
    }
  });
  const after = await getVatSettings(organizationId);
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "VAT_SETTINGS_UPDATED",
    entityType: "vat_settings",
    entityId: updated.id,
    beforeJson: before,
    afterJson: after,
    correlationId: input.correlationId
  });
  return after;
}

// ── Book rows (internal, Decimal) ───────────────────────────────────────────

export type VatBookRow = {
  id: string | null;
  organizationId: string;
  propertyId: string | null;
  book: VatBookName;
  date: string;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  base: Money;
  rate: Money;
  quota: Money;
  total: Money;
  retention: Money;
  taxFigure: string;
  surchargeRate: Money | null;
  surchargeQuota: Money | null;
  sourceType: VatBookSourceTypeCode;
  sourceId: string;
  period: string;
  deductible: boolean;
  /** FIX-1 · F2: régimen de la operación (null = sin clasificar; los escritores nativos escriben null). */
  regime: VatBookRegimeCode | null;
};

export function toVatBookRowDto(row: VatBookRow): VatBookRowDto {
  return {
    id: row.id,
    book: row.book,
    date: row.date,
    series: row.series,
    number: row.number,
    counterpartyNif: row.counterpartyNif,
    counterpartyName: row.counterpartyName,
    base: toWire(row.base),
    rate: toWire(row.rate),
    quota: toWire(row.quota),
    total: toWire(row.total),
    retention: toWire(row.retention),
    taxFigure: row.taxFigure,
    surchargeRate: row.surchargeRate === null ? null : toWire(row.surchargeRate),
    surchargeQuota: row.surchargeQuota === null ? null : toWire(row.surchargeQuota),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    period: row.period,
    deductible: row.deductible,
    propertyId: row.propertyId,
    regime: row.regime
  };
}

type PersistedVatRow = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  book: string;
  date: Date;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  base: Prisma.Decimal;
  rate: Prisma.Decimal;
  quota: Prisma.Decimal;
  total: Prisma.Decimal;
  retention: Prisma.Decimal;
  taxFigure: string;
  surchargeRate: Prisma.Decimal | null;
  surchargeQuota: Prisma.Decimal | null;
  sourceType: string;
  sourceId: string;
  period: string;
  deductible: boolean;
  regime: string | null;
};

export function fromPersistedRow(row: PersistedVatRow): VatBookRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    book: row.book as VatBookName,
    date: dateColumnDay(row.date),
    series: row.series,
    number: row.number,
    counterpartyNif: row.counterpartyNif,
    counterpartyName: row.counterpartyName,
    base: row.base,
    rate: row.rate,
    quota: row.quota,
    total: row.total,
    retention: row.retention,
    taxFigure: row.taxFigure,
    surchargeRate: row.surchargeRate,
    surchargeQuota: row.surchargeQuota,
    sourceType: row.sourceType as VatBookSourceTypeCode,
    sourceId: row.sourceId,
    period: row.period,
    deductible: row.deductible,
    regime: (row.regime as VatBookRegimeCode | null) ?? null
  };
}

/**
 * Fila del libro → input de `vatBookEntry.createMany`. Exportada (Tanda 7c · L2) para que el lote
 * `vat_books` importado de Sage 200 escriba sus filas (`sourceType sage200`) con la misma forma que
 * los escritores nativos.
 */
export function toVatBookCreateInput(row: VatBookRow): Prisma.VatBookEntryCreateManyInput {
  return {
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    book: row.book,
    date: dateColumn(row.date),
    series: row.series,
    number: row.number,
    counterpartyNif: row.counterpartyNif,
    counterpartyName: row.counterpartyName,
    base: round2(row.base),
    rate: round2(row.rate),
    quota: round2(row.quota),
    total: round2(row.total),
    retention: round2(row.retention),
    taxFigure: row.taxFigure,
    surchargeRate: row.surchargeRate === null ? null : round2(row.surchargeRate),
    surchargeQuota: row.surchargeQuota === null ? null : round2(row.surchargeQuota),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    period: row.period,
    deductible: row.deductible,
    regime: row.regime
  };
}

const toCreateInput = toVatBookCreateInput;

/** NIF normalised the way Supplier.taxId is stored: upper case, no spaces or dashes; null when empty. */
export function normalizeNif(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\s-]/g, "").toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

/** Series of an invoice number: `FAC-2026-000123` → `FAC-2026`; the explicit seriesCode wins. */
export function invoiceSeries(invoiceNumber: string | null, seriesCode: string | null): string | null {
  if (seriesCode) return seriesCode;
  if (!invoiceNumber) return null;
  const index = invoiceNumber.lastIndexOf("-");
  return index > 0 ? invoiceNumber.slice(0, index) : null;
}

const KNOWN_RATES = ["21", "10", "7", "5", "4", "3", "2", "0"].map((rate) => new Prisma.Decimal(rate));

/** Legacy supplier bills (no lines): infer the rate from quota / base, snapping to a known Spanish rate. */
export function inferRate(base: Money, quota: Money): Money {
  if (base.isZero() || quota.isZero()) return ZERO;
  const raw = quota.div(base).times(100);
  let best = KNOWN_RATES[0]!;
  for (const candidate of KNOWN_RATES) {
    if (raw.minus(candidate).abs().lessThan(raw.minus(best).abs())) best = candidate;
  }
  return best;
}

// ── Rows from an invoice (pure) ─────────────────────────────────────────────

export type InvoiceLineForBooks = {
  total: Prisma.Decimal | string | number;
  taxRate: Prisma.Decimal | string | number;
  taxCode: string;
  taxCalificacion: string | null;
  taxFigure: string | null;
};

export type InvoiceForBooks = {
  id: string;
  propertyId: string;
  invoiceNumber: string | null;
  invoiceType: string;
  status: string;
  issuedAt: Date | null;
  cancelledAt: Date | null;
  customerTaxId: string | null;
  customerName: string | null;
  taxBreakdownJson: unknown;
  seriesCode: string | null;
  simplified: boolean;
  rectifyingForId: string | null;
  /** VeriFactu TipoRectificativa of a rectificativa: «I» (diferencias) or «S» (sustitución); null on ordinary invoices. */
  rectificationType?: string | null;
  lines: InvoiceLineForBooks[];
};

type TaxGroup = { figure: string; rate: Money; base: Money; quota: Money; subject: boolean };

function figureFromTaxCode(taxCode: string, taxFigure: string | null): string {
  if (taxFigure === "IGIC" || taxFigure === "IPSI" || taxFigure === "IVA") return taxFigure;
  const upper = taxCode.toUpperCase();
  if (upper.includes("IGIC")) return "IGIC";
  if (upper.includes("IPSI")) return "IPSI";
  return "IVA";
}

/** Group gross lines by (figure, rate) with the per-group rounding of contract B, in Decimal. */
export function taxGroupsFromLines(lines: readonly InvoiceLineForBooks[]): TaxGroup[] {
  const groups = new Map<string, { figure: string; rate: Money; gross: Money; subject: boolean }>();
  for (const line of lines) {
    const figure = figureFromTaxCode(line.taxCode, line.taxFigure);
    const subject = line.taxCalificacion !== "N1";
    const rate = subject ? round2(money(line.taxRate)) : ZERO;
    const key = `${figure}::${subject ? "S1" : "N1"}::${rate.toFixed(2)}`;
    const group = groups.get(key);
    if (group) group.gross = group.gross.plus(money(line.total));
    else groups.set(key, { figure, rate, gross: money(line.total), subject });
  }
  const result: TaxGroup[] = [];
  for (const group of groups.values()) {
    const gross = round2(group.gross);
    const taxable = group.subject && group.rate.greaterThan(0);
    const base = taxable ? round2(gross.div(group.rate.div(100).plus(1))) : gross;
    const quota = taxable ? round2(gross.minus(base)) : ZERO;
    result.push({ figure: group.figure, rate: group.rate, base, quota, subject: group.subject });
  }
  return result;
}

/** Tax groups of an invoice: the persisted VeriFactu breakdown when present (contract B), else the lines. */
export function taxGroupsOfInvoice(invoice: InvoiceForBooks): TaxGroup[] {
  const breakdown = parseTaxBreakdown(invoice.taxBreakdownJson);
  if (breakdown.length > 0) {
    return breakdown.map((group) => ({
      figure: group.figure,
      rate: round2(money(group.ratePercent)),
      base: round2(money(group.base)),
      quota: round2(money(group.quota)),
      subject: group.calificacion !== "N1"
    }));
  }
  return taxGroupsFromLines(invoice.lines);
}

export function invoiceSourceType(invoice: Pick<InvoiceForBooks, "invoiceType" | "rectifyingForId" | "simplified">): VatBookSourceTypeCode {
  if (invoice.rectifyingForId || invoice.invoiceType.startsWith("R")) return "rectification";
  if (invoice.simplified || invoice.invoiceType === "F2") return "simplified";
  return "invoice";
}

// ── sourceId convention of the counter-rows (Tanda L3-C) ────────────────────
//
// ONE convention for the live writer (invoice.service.ts → invoicing/vat-book.ts)
// and the derived rows of this module; see the header. The legacy `:anulacion`
// suffix of the rebuilds before 2026-09-18 is only recognised to be purged.

/** Suffix of the negating rows of a cancelled invoice / expense: `<id>#anulacion`. */
export const VAT_BOOK_CANCELLATION_SUFFIX = "#anulacion";
/** Suffix of the negating rows of an invoice replaced by a rectificativa «S»: `<id>#sustituida`. */
export const VAT_BOOK_SUPERSEDED_SUFFIX = "#sustituida";
/** Pre-L3 cancellation suffix (`<id>:anulacion`), written by rebuilds before 2026-09-18: purged, never written. */
export const LEGACY_VAT_BOOK_CANCELLATION_SUFFIX = ":anulacion";

export function cancellationSourceId(documentId: string): string {
  return `${documentId}${VAT_BOOK_CANCELLATION_SUFFIX}`;
}

export function supersededSourceId(documentId: string): string {
  return `${documentId}${VAT_BOOK_SUPERSEDED_SUFFIX}`;
}

export function legacyCancellationSourceId(documentId: string): string {
  return `${documentId}${LEGACY_VAT_BOOK_CANCELLATION_SUFFIX}`;
}

/** Document id behind a sourceId of any convention (`<id>`, `<id>#anulacion`, `<id>#sustituida`, `<id>:anulacion`). */
export function vatBookDocumentId(sourceId: string): string {
  for (const suffix of [VAT_BOOK_CANCELLATION_SUFFIX, VAT_BOOK_SUPERSEDED_SUFFIX, LEGACY_VAT_BOOK_CANCELLATION_SUFFIX]) {
    if (sourceId.endsWith(suffix)) return sourceId.slice(0, -suffix.length);
  }
  return sourceId;
}

export type VatRowKind = "issue" | "cancellation" | "superseded";

/**
 * Emitidas rows of an invoice: one per (rate), merging the S1 and N1 groups
 * of the same rate (the unique key has no calificación). `avisos` collects
 * the fiscal problems that do not stop the book (S1 lines at 0 %, missing
 * customer NIF on a full invoice).
 *
 * `kind`:
 *   · `issue` (default) — the document's own rows, dated on `issuedAt`;
 *   · `cancellation` — the negating rows (`<id>#anulacion`) dated on
 *     `cancelledAt`; none when the invoice is not cancelled;
 *   · `superseded` — the negating rows (`<id>#sustituida`) of an original
 *     replaced by a rectificativa por sustitución («S»), dated on the
 *     substitute's issue instant (`supersededAt`); none without it.
 */
export function vatRowsFromInvoice(input: {
  invoice: InvoiceForBooks;
  organizationId: string;
  periodicity: VatPeriodicityCode;
  /** `issue` rows (default), the negating `cancellation` rows or the negating `superseded` rows. */
  kind?: VatRowKind;
  /** Issue instant of the substitute rectificativa (kind `superseded` only). */
  supersededAt?: Date | null;
}): { rows: VatBookRow[]; avisos: string[] } {
  const { invoice } = input;
  const kind = input.kind ?? "issue";
  const avisos: string[] = [];
  if (invoice.status === "draft" || !invoice.issuedAt) return { rows: [], avisos };
  if (kind === "cancellation" && !invoice.cancelledAt) return { rows: [], avisos };
  if (kind === "superseded" && !input.supersededAt) return { rows: [], avisos };
  const day = kind === "cancellation" ? madridDay(invoice.cancelledAt!) : kind === "superseded" ? madridDay(input.supersededAt!) : madridDay(invoice.issuedAt);
  const sign = kind === "issue" ? new Prisma.Decimal(1) : new Prisma.Decimal(-1);
  const sourceId = kind === "cancellation" ? cancellationSourceId(invoice.id) : kind === "superseded" ? supersededSourceId(invoice.id) : invoice.id;
  const sourceType = invoiceSourceType(invoice);
  const label = invoice.invoiceNumber ?? invoice.id;
  const groups = taxGroupsOfInvoice(invoice);
  const byRate = new Map<string, VatBookRow>();
  for (const group of groups) {
    if (group.subject && group.rate.isZero() && !group.base.isZero()) {
      avisos.push(`Factura ${label}: líneas sujetas al 0 % sin tipo configurado (base ${group.base.toFixed(2)} €); revisa el catálogo fiscal del establecimiento.`);
    }
    const key = `${group.figure}::${group.rate.toFixed(2)}`;
    const existing = byRate.get(key);
    const base = group.base.times(sign);
    const quota = group.quota.times(sign);
    if (existing) {
      existing.base = existing.base.plus(base);
      existing.quota = existing.quota.plus(quota);
      existing.total = existing.total.plus(base).plus(quota);
      continue;
    }
    byRate.set(key, {
      id: null,
      organizationId: input.organizationId,
      propertyId: invoice.propertyId,
      book: "emitidas",
      date: day,
      series: invoiceSeries(invoice.invoiceNumber, invoice.seriesCode),
      number: invoice.invoiceNumber,
      counterpartyNif: normalizeNif(invoice.customerTaxId),
      counterpartyName: invoice.customerName ?? null,
      base,
      rate: group.rate,
      quota,
      total: base.plus(quota),
      retention: ZERO,
      taxFigure: group.figure,
      surchargeRate: null,
      surchargeQuota: null,
      sourceType,
      sourceId,
      period: periodCodeForDate(day, input.periodicity),
      deductible: true,
      regime: null
    });
  }
  if (sourceType === "invoice" && !normalizeNif(invoice.customerTaxId) && kind === "issue") {
    avisos.push(`Factura ${label}: factura completa sin NIF del destinatario (no computa en el Modelo 347).`);
  }
  return { rows: Array.from(byRate.values()), avisos };
}

// ── Rows from a supplier bill / expense (pure) ──────────────────────────────

export type SupplierBillLineForBooks = {
  base: Prisma.Decimal | string | number;
  taxRate: Prisma.Decimal | string | number;
  quota: Prisma.Decimal | string | number;
  retention: Prisma.Decimal | string | number;
  investmentGood: boolean;
};

export type SupplierBillForBooks = {
  id: string;
  propertyId: string;
  supplierName: string | null;
  supplierTaxId: string | null;
  invoiceNumber: string | null;
  issueDate: Date | null;
  postedAt: Date | null;
  createdAt: Date;
  baseTotal: Prisma.Decimal | string | number;
  taxTotal: Prisma.Decimal | string | number;
  total: Prisma.Decimal | string | number;
  retentionAmount: Prisma.Decimal | string | number | null;
  status: string;
  lines: SupplierBillLineForBooks[];
};

export const SUPPLIER_BILL_BOOK_STATUSES: readonly string[] = ["posted", "paid"];

export function vatRowsFromSupplierBill(input: { bill: SupplierBillForBooks; organizationId: string; periodicity: VatPeriodicityCode; taxFigure?: string }): { rows: VatBookRow[]; avisos: string[] } {
  const { bill } = input;
  const avisos: string[] = [];
  if (!SUPPLIER_BILL_BOOK_STATUSES.includes(bill.status)) return { rows: [], avisos };
  const day = bill.issueDate ? dateColumnDay(bill.issueDate) : madridDay(bill.postedAt ?? bill.createdAt);
  const nif = normalizeNif(bill.supplierTaxId);
  const label = bill.invoiceNumber ?? bill.id;
  if (!nif) avisos.push(`Factura recibida ${label}: sin NIF del proveedor; la cuota soportada no es deducible hasta completar la factura.`);
  const common = {
    id: null,
    organizationId: input.organizationId,
    propertyId: bill.propertyId,
    date: day,
    series: null,
    number: bill.invoiceNumber,
    counterpartyNif: nif,
    counterpartyName: bill.supplierName,
    taxFigure: input.taxFigure ?? "IVA",
    surchargeRate: null,
    surchargeQuota: null,
    sourceType: "supplier_bill" as const,
    sourceId: bill.id,
    period: periodCodeForDate(day, input.periodicity),
    deductible: Boolean(nif),
    regime: null as VatBookRegimeCode | null
  };
  const grouped = new Map<string, VatBookRow>();
  if (bill.lines.length > 0) {
    for (const line of bill.lines) {
      const rate = round2(money(line.taxRate));
      const book: VatBookName = line.investmentGood ? "bienes_inversion" : "recibidas";
      const key = `${book}::${rate.toFixed(2)}`;
      const base = round2(money(line.base));
      const quota = round2(money(line.quota));
      const retention = round2(money(line.retention));
      const existing = grouped.get(key);
      if (existing) {
        existing.base = existing.base.plus(base);
        existing.quota = existing.quota.plus(quota);
        existing.total = existing.total.plus(base).plus(quota);
        existing.retention = existing.retention.plus(retention);
        continue;
      }
      grouped.set(key, { ...common, book, base, rate, quota, total: base.plus(quota), retention });
    }
    return { rows: Array.from(grouped.values()), avisos };
  }
  // Legacy bill (accounting.service.createSupplierBillDraft): header only.
  const taxTotal = round2(money(bill.taxTotal));
  const baseTotal = money(bill.baseTotal);
  const base = baseTotal.greaterThan(0) ? round2(baseTotal) : round2(money(bill.total).minus(taxTotal));
  const rate = inferRate(base, taxTotal);
  avisos.push(`Factura recibida ${label}: sin líneas (registro heredado); tipo inferido ${rate.toFixed(0)} % a partir de cuota / base.`);
  return {
    rows: [{ ...common, book: "recibidas", base, rate, quota: taxTotal, total: base.plus(taxTotal), retention: round2(money(bill.retentionAmount)) }],
    avisos
  };
}

export type ExpenseForBooks = {
  id: string;
  propertyId: string | null;
  date: Date;
  supplierName: string;
  supplierNif: string | null;
  concept: string;
  base: Prisma.Decimal | string | number;
  taxRate: Prisma.Decimal | string | number;
  quota: Prisma.Decimal | string | number;
  total: Prisma.Decimal | string | number;
  vatDeductible: boolean;
  cancelledAt: Date | null;
};

export function vatRowsFromExpense(input: { expense: ExpenseForBooks; organizationId: string; periodicity: VatPeriodicityCode; kind?: "issue" | "cancellation"; taxFigure?: string }): { rows: VatBookRow[]; avisos: string[] } {
  const { expense } = input;
  const kind = input.kind ?? "issue";
  const avisos: string[] = [];
  if (kind === "cancellation" && !expense.cancelledAt) return { rows: [], avisos };
  const day = kind === "cancellation" ? madridDay(expense.cancelledAt!) : dateColumnDay(expense.date);
  const sign = kind === "cancellation" ? new Prisma.Decimal(-1) : new Prisma.Decimal(1);
  const nif = normalizeNif(expense.supplierNif);
  const deductible = expense.vatDeductible && Boolean(nif);
  if (kind === "issue" && !deductible && !money(expense.quota).isZero()) {
    avisos.push(`Gasto «${expense.concept}» (${expense.supplierName}): cuota no deducible (${nif ? "marcado como no deducible" : "ticket sin NIF"}); la cuota va al gasto.`);
  }
  const base = round2(money(expense.base)).times(sign);
  const quota = round2(money(expense.quota)).times(sign);
  return {
    rows: [
      {
        id: null,
        organizationId: input.organizationId,
        propertyId: expense.propertyId,
        book: "recibidas",
        date: day,
        series: null,
        number: null,
        counterpartyNif: nif,
        counterpartyName: expense.supplierName,
        base,
        rate: round2(money(expense.taxRate)),
        quota,
        total: base.plus(quota),
        retention: ZERO,
        taxFigure: input.taxFigure ?? "IVA",
        surchargeRate: null,
        surchargeQuota: null,
        sourceType: "expense",
        sourceId: kind === "cancellation" ? cancellationSourceId(expense.id) : expense.id,
        period: periodCodeForDate(day, input.periodicity),
        deductible,
        regime: null
      }
    ],
    avisos
  };
}

// ── Summaries ───────────────────────────────────────────────────────────────

export function summarizeVatRows(rows: readonly VatBookRow[]): VatBookSummary {
  const byRate = new Map<string, { rate: Money; filas: number; base: Money; cuota: Money; total: Money; retencion: Money }>();
  let base = ZERO;
  let cuota = ZERO;
  let total = ZERO;
  let retencion = ZERO;
  for (const row of rows) {
    const key = row.rate.toFixed(2);
    const bucket = byRate.get(key) ?? { rate: row.rate, filas: 0, base: ZERO, cuota: ZERO, total: ZERO, retencion: ZERO };
    bucket.filas += 1;
    bucket.base = bucket.base.plus(row.base);
    bucket.cuota = bucket.cuota.plus(row.quota);
    bucket.total = bucket.total.plus(row.total);
    bucket.retencion = bucket.retencion.plus(row.retention);
    byRate.set(key, bucket);
    base = base.plus(row.base);
    cuota = cuota.plus(row.quota);
    total = total.plus(row.total);
    retencion = retencion.plus(row.retention);
  }
  return {
    filas: rows.length,
    base: toWire(base),
    cuota: toWire(cuota),
    total: toWire(total),
    retencion: toWire(retencion),
    porTipo: Array.from(byRate.values())
      .sort((a, b) => b.rate.comparedTo(a.rate))
      .map((bucket) => ({ rate: toWire(bucket.rate), filas: bucket.filas, base: toWire(bucket.base), cuota: toWire(bucket.cuota), total: toWire(bucket.total), retencion: toWire(bucket.retencion) }))
  };
}

// ── Documents → rows (Prisma) ───────────────────────────────────────────────

type DocumentClient = Pick<Prisma.TransactionClient, "invoice" | "supplierBill" | "expense" | "property" | "vatBookEntry">;

function shiftDay(isoDay: string, days: number): Date {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function propertyIdsOf(organizationId: string, propertyId: string | null | undefined, client: DocumentClient): Promise<string[]> {
  if (propertyId) return [propertyId];
  const rows = await client.property.findMany({ where: { organizationId }, select: { id: true } });
  return rows.map((row) => row.id);
}

export type DerivedVatRows = {
  rows: VatBookRow[];
  avisos: string[];
  documentos: { facturas: number; anulaciones: number; facturasRecibidas: number; gastos: number };
};

/** Invoice columns `vatRowsFromInvoice` needs (exported for the Modelo 303 in-memory `#sustituida` synthesis, corrector L3 · DS-06). */
export const INVOICE_FOR_BOOKS_SELECT = {
  id: true,
  propertyId: true,
  invoiceNumber: true,
  invoiceType: true,
  status: true,
  issuedAt: true,
  cancelledAt: true,
  customerTaxId: true,
  customerName: true,
  taxBreakdownJson: true,
  seriesCode: true,
  simplified: true,
  rectifyingForId: true,
  rectificationType: true
} as const;

/** A rectificativa por sustitución («S»): its original's rows are countered on the substitute's issue day. */
function isSubstituteRectification(invoice: Pick<InvoiceForBooks, "rectifyingForId" | "rectificationType" | "status" | "issuedAt">): invoice is Pick<InvoiceForBooks, "rectifyingForId" | "rectificationType" | "status" | "issuedAt"> & { rectifyingForId: string; issuedAt: Date } {
  return Boolean(invoice.rectifyingForId) && invoice.rectificationType === "S" && invoice.status !== "draft" && Boolean(invoice.issuedAt);
}

/**
 * Derive the book rows of a date range straight from the documents (what the
 * writers would have materialised). Rows outside the range (a cancellation
 * after `to`, an issue before `from`) are dropped.
 *
 * Tanda L3-C: for every rectificativa por sustitución («S») issued in the
 * range the ORIGINAL's negating rows (`<originalId>#sustituida`, dated on the
 * substitute's issue day) are derived too — exactly what the live writer
 * materialises (invoice.service.ts createRectifyingInvoice) — so a rebuild
 * never counts the replaced invoice twice. The original may have been issued
 * before `from`: it is loaded by id when the window did not bring it.
 */
export async function deriveVatBookRows(input: { organizationId: string; from: string; to: string; propertyId?: string | null; periodicity: VatPeriodicityCode; taxFigure?: string; client?: DocumentClient }): Promise<DerivedVatRows> {
  const client = input.client ?? prisma;
  const propertyIds = await propertyIdsOf(input.organizationId, input.propertyId, client);
  const inRange = (day: string): boolean => day >= input.from && day <= input.to;
  const avisos: string[] = [];
  const rows: VatBookRow[] = [];
  const documentos = { facturas: 0, anulaciones: 0, facturasRecibidas: 0, gastos: 0 };
  // Timestamps are converted to Madrid days: widen the SQL window by a day on each side and filter in memory.
  const windowStart = shiftDay(input.from, -1);
  const windowEnd = shiftDay(input.to, 2);

  if (propertyIds.length > 0) {
    const invoices = await client.invoice.findMany({
      where: {
        propertyId: { in: propertyIds },
        deletedAt: null,
        status: { in: ["issued", "rectified", "cancelled"] },
        OR: [{ issuedAt: { gte: windowStart, lt: windowEnd } }, { cancelledAt: { gte: windowStart, lt: windowEnd } }]
      },
      select: INVOICE_FOR_BOOKS_SELECT,
      orderBy: [{ issuedAt: "asc" }]
    });
    // Originals of the substitute rectificativas of the window that the window itself did not bring
    // (issued in an earlier range, or rectified before `from` — the rectified status has no date column).
    const loadedIds = new Set(invoices.map((invoice) => invoice.id));
    const missingOriginalIds = Array.from(new Set(invoices.filter(isSubstituteRectification).map((invoice) => invoice.rectifyingForId).filter((id): id is string => Boolean(id) && !loadedIds.has(id!))));
    const originals = missingOriginalIds.length > 0
      ? await client.invoice.findMany({ where: { id: { in: missingOriginalIds }, propertyId: { in: propertyIds }, deletedAt: null }, select: INVOICE_FOR_BOOKS_SELECT })
      : [];
    const invoiceIds = [...invoices, ...originals].map((invoice) => invoice.id);
    const lines = invoiceIds.length > 0
      ? await (client as Prisma.TransactionClient).invoiceLine.findMany({
          where: { invoiceId: { in: invoiceIds } },
          select: { invoiceId: true, total: true, taxRate: true, taxCode: true, taxCalificacion: true, taxFigure: true }
        })
      : [];
    const linesByInvoice = new Map<string, InvoiceLineForBooks[]>();
    for (const line of lines) {
      const bucket = linesByInvoice.get(line.invoiceId) ?? [];
      bucket.push(line);
      linesByInvoice.set(line.invoiceId, bucket);
    }
    const forBooksById = new Map<string, InvoiceForBooks>();
    for (const invoice of [...invoices, ...originals]) forBooksById.set(invoice.id, { ...invoice, lines: linesByInvoice.get(invoice.id) ?? [] });
    for (const invoice of invoices) {
      const forBooks = forBooksById.get(invoice.id)!;
      const issue = vatRowsFromInvoice({ invoice: forBooks, organizationId: input.organizationId, periodicity: input.periodicity });
      const issueRows = issue.rows.filter((row) => inRange(row.date));
      if (issueRows.length > 0) {
        documentos.facturas += 1;
        rows.push(...issueRows);
        avisos.push(...issue.avisos);
      }
      const cancellation = vatRowsFromInvoice({ invoice: forBooks, organizationId: input.organizationId, periodicity: input.periodicity, kind: "cancellation" });
      const cancellationRows = cancellation.rows.filter((row) => inRange(row.date));
      if (cancellationRows.length > 0) {
        documentos.anulaciones += 1;
        rows.push(...cancellationRows);
      }
      // Rectificativa «S»: counter the original on the substitute's issue day (same rows as the live writer).
      if (isSubstituteRectification(invoice)) {
        const original = forBooksById.get(invoice.rectifyingForId);
        if (!original) {
          avisos.push(`Rectificativa ${invoice.invoiceNumber ?? invoice.id} por sustitución: la factura original ${invoice.rectifyingForId} no existe o está borrada; el libro no puede contrarrestarla.`);
          continue;
        }
        const superseded = vatRowsFromInvoice({ invoice: original, organizationId: input.organizationId, periodicity: input.periodicity, kind: "superseded", supersededAt: invoice.issuedAt });
        const supersededRows = superseded.rows.filter((row) => inRange(row.date));
        if (supersededRows.length > 0) {
          documentos.anulaciones += 1;
          rows.push(...supersededRows);
        }
      }
    }

    const bills = await client.supplierBill.findMany({
      where: {
        propertyId: { in: propertyIds },
        status: { in: ["posted", "paid"] },
        cancelledAt: null,
        OR: [{ issueDate: { gte: dateColumn(input.from), lte: dateColumn(input.to) } }, { issueDate: null, postedAt: { gte: windowStart, lt: windowEnd } }, { issueDate: null, postedAt: null, createdAt: { gte: windowStart, lt: windowEnd } }]
      },
      include: { lines: { select: { base: true, taxRate: true, quota: true, retention: true, investmentGood: true } } },
      orderBy: [{ issueDate: "asc" }]
    });
    for (const bill of bills) {
      const derived = vatRowsFromSupplierBill({ bill, organizationId: input.organizationId, periodicity: input.periodicity, taxFigure: input.taxFigure });
      const billRows = derived.rows.filter((row) => inRange(row.date));
      if (billRows.length > 0) {
        documentos.facturasRecibidas += 1;
        rows.push(...billRows);
        avisos.push(...derived.avisos);
      }
    }
  }

  const expenses = await client.expense.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      OR: [{ date: { gte: dateColumn(input.from), lte: dateColumn(input.to) } }, { cancelledAt: { gte: windowStart, lt: windowEnd } }]
    },
    orderBy: [{ date: "asc" }]
  });
  for (const expense of expenses) {
    const issue = vatRowsFromExpense({ expense, organizationId: input.organizationId, periodicity: input.periodicity, taxFigure: input.taxFigure });
    const issueRows = issue.rows.filter((row) => inRange(row.date));
    if (issueRows.length > 0) {
      documentos.gastos += 1;
      rows.push(...issueRows);
      avisos.push(...issue.avisos);
    }
    const cancellation = vatRowsFromExpense({ expense, organizationId: input.organizationId, periodicity: input.periodicity, kind: "cancellation", taxFigure: input.taxFigure });
    rows.push(...cancellation.rows.filter((row) => inRange(row.date)));
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? "").localeCompare(b.number ?? "") || a.sourceId.localeCompare(b.sourceId));
  return { rows, avisos, documentos };
}

export type LoadedVatBookRows = {
  /** Per book: `libros` (materialised) or `documentos` (derived in memory). */
  origen: Record<VatBookName, "libros" | "documentos">;
  rows: VatBookRow[];
  avisos: string[];
};

/**
 * Rows of a range for the models. Per book: the materialised rows when the
 * range has any, otherwise the rows derived from the documents (flagged in
 * `origen` and `avisos`). Read-only.
 */
/** GET /fiscal/vat-books (Tanda L2 · L2-05): page size (default and maximum) of the keyset page on (date, id). */
export const VAT_BOOK_PAGE_LIMIT = 500;
/** Explicit bound of the whole-range reads of the models (303 / 390 / 347…): ≈ 3.000 rows a year at Faranda; a hit is reported in `avisos`. */
export const VAT_BOOK_MAX_ROWS = 50_000;

export async function loadVatBookRows(input: { organizationId: string; from: string; to: string; propertyId?: string | null; periodicity: VatPeriodicityCode; taxFigure?: string; books?: readonly VatBookName[] }): Promise<LoadedVatBookRows> {
  const books = input.books ?? (["emitidas", "recibidas", "bienes_inversion"] as const);
  const persisted = await prisma.vatBookEntry.findMany({
    where: {
      organizationId: input.organizationId,
      book: { in: [...books] },
      date: { gte: dateColumn(input.from), lte: dateColumn(input.to) },
      ...(input.propertyId ? { propertyId: input.propertyId } : {})
    },
    orderBy: [{ date: "asc" }, { number: "asc" }],
    take: VAT_BOOK_MAX_ROWS + 1
  });
  const avisos: string[] = [];
  if (persisted.length > VAT_BOOK_MAX_ROWS) {
    persisted.length = VAT_BOOK_MAX_ROWS;
    avisos.push(`Los libros del rango ${input.from}..${input.to} superan ${VAT_BOOK_MAX_ROWS} filas: el cálculo usa las primeras ${VAT_BOOK_MAX_ROWS} por fecha; acota el rango.`);
  }
  const origen = { emitidas: "libros", recibidas: "libros", bienes_inversion: "libros" } as Record<VatBookName, "libros" | "documentos">;
  const rows: VatBookRow[] = persisted.map(fromPersistedRow);
  const missing = books.filter((book) => !persisted.some((row) => row.book === book));
  if (missing.length > 0) {
    const derived = await deriveVatBookRows({ organizationId: input.organizationId, from: input.from, to: input.to, propertyId: input.propertyId, periodicity: input.periodicity, taxFigure: input.taxFigure });
    for (const book of missing) {
      // A book with no persisted rows is "derived" only when the documents
      // actually yield rows for it; an empty book after a rebuild (no
      // investment goods this quarter) is simply empty, not unmaterialised.
      const derivedRows = derived.rows.filter((row) => row.book === book);
      if (derivedRows.length === 0) continue;
      origen[book] = "documentos";
      rows.push(...derivedRows);
      avisos.push(`Libro de ${book.replace("_", " ")}: sin filas materializadas en ${input.from}..${input.to}; importes calculados directamente desde los documentos (ejecuta POST /fiscal/vat-books/rebuild para materializarlos).`);
    }
    avisos.push(...derived.avisos);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? "").localeCompare(b.number ?? "") || a.sourceId.localeCompare(b.sourceId));
  return { origen, rows, avisos };
}

// ── Periods with materialised rows (FIX-1 · F3, E-04) ───────────────────────

export type VatBookPeriodRow = { period: string; rows: number; lastDate: string | null };

/**
 * Pure: the periods newest first (by the date of their newest row, then by
 * code) and the code of the newest one — the default period of the 303 and
 * the books screens («último periodo con libros materializados»).
 */
export function latestPeriodOf(rows: readonly VatBookPeriodRow[]): { periods: VatBookPeriodRow[]; latest: string | null } {
  const periods = [...rows].sort((a, b) => (b.lastDate ?? "").localeCompare(a.lastDate ?? "") || b.period.localeCompare(a.period));
  return { periods, latest: periods[0]?.period ?? null };
}

/** GET /fiscal/vat-books/periods: one groupBy over the organisation's book rows (never the rows themselves). Read-only. */
export async function listVatBookPeriods(organizationId: string): Promise<VatBookPeriodsResponse> {
  const groups = await prisma.vatBookEntry.groupBy({ by: ["period"], where: { organizationId }, _count: { _all: true }, _max: { date: true } });
  const { periods, latest } = latestPeriodOf(groups.map((group) => ({ period: group.period, rows: group._count._all, lastDate: group._max.date ? dateColumnDay(group._max.date) : null })));
  return { organizationId, periods, latest };
}

/**
 * FIX-1 · F3 (E-03): rows imported from Sage 200 carry no centre (`propertyId`
 * null, the lots have no delegation), so a centre view of a Sage period is
 * empty for that reason — not because the centre had no operations. Count
 * of such rows in the range (0 → the emptiness is real). Read-only.
 */
export async function countSageRowsWithoutCentre(organizationId: string, from: string, to: string): Promise<number> {
  return prisma.vatBookEntry.count({ where: { organizationId, sourceType: "sage200", propertyId: null, date: { gte: dateColumn(from), lte: dateColumn(to) } } });
}

// ── Writers for the other lots (same transaction as the document) ───────────

type WriterClient = Prisma.TransactionClient;

/**
 * delete + insert by source key. A `<id>#anulacion` key also purges the legacy
 * `<id>:anulacion` row of the same book / sourceType (rebuilds before Tanda L3-C),
 * so the two conventions never add up.
 */
async function replaceRows(tx: WriterClient, organizationId: string, keys: Array<{ book: VatBookName; sourceType: VatBookSourceTypeCode; sourceId: string }>, rows: VatBookRow[]): Promise<number> {
  for (const key of keys) {
    const sourceIds = key.sourceId.endsWith(VAT_BOOK_CANCELLATION_SUFFIX) ? [key.sourceId, legacyCancellationSourceId(vatBookDocumentId(key.sourceId))] : [key.sourceId];
    await tx.vatBookEntry.deleteMany({ where: { organizationId, book: key.book, sourceType: key.sourceType, sourceId: { in: sourceIds } } });
  }
  if (rows.length === 0) return 0;
  const created = await tx.vatBookEntry.createMany({ data: rows.map(toCreateInput) });
  return created.count;
}

// The invoice writers (`registerInvoiceInVatBooks`, `registerInvoiceCancellationInVatBooks`)
// were retired in Tanda L3-C (no caller: invoice.service.ts writes the emitidas
// book live through invoicing/vat-book.ts). The two payables writers below have
// no external caller either (payables/vat-book.ts writes its own rows) but stay
// out of the L3 scope: they are kept for the suppliers lot, unchanged.

/** Recibidas / bienes_inversion rows of a posted supplier bill (call inside the posting transaction). */
export async function registerSupplierBillInVatBooks(tx: WriterClient, supplierBillId: string): Promise<{ rows: number; avisos: string[] }> {
  const bill = await tx.supplierBill.findUnique({ where: { id: supplierBillId }, include: { lines: { select: { base: true, taxRate: true, quota: true, retention: true, investmentGood: true } } } });
  if (!bill) throw new ConflictError("La factura recibida no existe.", { code: "SUPPLIER_BILL_NOT_FOUND" });
  const organizationId = bill.organizationId ?? (await tx.property.findUnique({ where: { id: bill.propertyId }, select: { organizationId: true } }))?.organizationId;
  if (!organizationId) throw new ConflictError("La factura recibida no tiene organización.", { code: "SUPPLIER_BILL_WITHOUT_ORGANIZATION" });
  const settings = await getVatSettings(organizationId, tx);
  const derived = vatRowsFromSupplierBill({ bill, organizationId, periodicity: settings.periodicity, taxFigure: settings.taxFigure });
  const rows = await replaceRows(
    tx,
    organizationId,
    [
      { book: "recibidas", sourceType: "supplier_bill", sourceId: bill.id },
      { book: "bienes_inversion", sourceType: "supplier_bill", sourceId: bill.id }
    ],
    derived.rows
  );
  return { rows, avisos: derived.avisos };
}

/** Recibidas row of an expense (`kind: "cancellation"` writes the negating row). */
export async function registerExpenseInVatBooks(tx: WriterClient, expenseId: string, kind: "issue" | "cancellation" = "issue"): Promise<{ rows: number; avisos: string[] }> {
  const expense = await tx.expense.findUnique({ where: { id: expenseId } });
  if (!expense) throw new ConflictError("El gasto no existe.", { code: "EXPENSE_NOT_FOUND" });
  const settings = await getVatSettings(expense.organizationId, tx);
  const derived = vatRowsFromExpense({ expense, organizationId: expense.organizationId, periodicity: settings.periodicity, kind, taxFigure: settings.taxFigure });
  const sourceId = kind === "cancellation" ? cancellationSourceId(expense.id) : expense.id;
  const rows = await replaceRows(tx, expense.organizationId, [{ book: "recibidas", sourceType: "expense", sourceId }], derived.rows);
  return { rows, avisos: derived.avisos };
}

// ── Rebuild (materialise a range) ───────────────────────────────────────────

export async function rebuildVatBooks(input: { context: UserContext; from: string; to: string; propertyId?: string | null; correlationId?: string }): Promise<VatBooksRebuildResponse> {
  requirePermissions(input.context, ["accounting.configure"]);
  if (!isIsoDay(input.from) || !isIsoDay(input.to) || input.from > input.to) {
    throw new BadRequestError("Indica un rango de fechas válido (from ≤ to, formato YYYY-MM-DD).");
  }
  const organizationId = input.context.organizationId;
  const result = await prisma.$transaction(
    async (tx) => {
      const settings = await ensureVatSettings(organizationId, tx);
      const derived = await deriveVatBookRows({ organizationId, from: input.from, to: input.to, propertyId: input.propertyId, periodicity: settings.periodicity, taxFigure: settings.taxFigure, client: tx });
      // Tanda 7c (importación desde Sage 200): las filas importadas (`sourceType sage200`) no salen de
      // ningún documento de Anfitorio, así que el rebuild no puede regenerarlas: se conservan siempre.
      const deleted = await tx.vatBookEntry.deleteMany({
        where: { organizationId, sourceType: { not: "sage200" }, date: { gte: dateColumn(input.from), lte: dateColumn(input.to) }, ...(input.propertyId ? { propertyId: input.propertyId } : {}) }
      });
      // Tanda L3-C: the legacy `<id>:anulacion` rows (rebuilds before 2026-09-18) of the documents whose
      // `<id>#anulacion` rows are materialised now are purged whatever their date (a legacy row dated
      // outside the range would otherwise survive next to the new one and count the cancellation twice).
      const legacyIds = derived.rows.filter((row) => row.sourceId.endsWith(VAT_BOOK_CANCELLATION_SUFFIX)).map((row) => legacyCancellationSourceId(vatBookDocumentId(row.sourceId)));
      const legacy = legacyIds.length > 0
        ? await tx.vatBookEntry.deleteMany({ where: { organizationId, sourceType: { not: "sage200" }, sourceId: { in: Array.from(new Set(legacyIds)) } } })
        : { count: 0 };
      const created: Record<VatBookName, number> = { emitidas: 0, recibidas: 0, bienes_inversion: 0 };
      if (derived.rows.length > 0) {
        await tx.vatBookEntry.createMany({ data: derived.rows.map(toCreateInput) });
        for (const row of derived.rows) created[row.book] += 1;
      }
      return { deleted: deleted.count + legacy.count, legacyPurged: legacy.count, created, derived };
    },
    { maxWait: 15_000, timeout: 120_000 }
  );
  const avisos = [...result.derived.avisos];
  if (result.legacyPurged > 0) {
    avisos.push(`${result.legacyPurged} fila(s) de anulación con la convención anterior (\`:anulacion\`) retiradas fuera del rango: sustituidas por sus contrafilas \`#anulacion\`.`);
  }
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "VAT_BOOKS_REBUILT",
    entityType: "vat_book",
    entityId: `${organizationId}:${input.from}:${input.to}`,
    afterJson: { from: input.from, to: input.to, deleted: result.deleted, legacyPurged: result.legacyPurged, created: result.created, documentos: result.derived.documentos },
    correlationId: input.correlationId
  });
  return {
    organizationId,
    propertyId: input.propertyId ?? null,
    from: input.from,
    to: input.to,
    deleted: result.deleted,
    created: result.created,
    documentos: result.derived.documentos,
    avisos
  };
}

// ── Listing ─────────────────────────────────────────────────────────────────

/** The book the front reads (`rows`, `resumen`, `origen`, `avisos`, `periodo`) plus the page fields. */
export type VatBookPage = VatBookResponse & { total: number; nextCursor: string | null };

type VatRateGroup = { rate: Prisma.Decimal; _count: { _all: number }; _sum: { base: Prisma.Decimal | null; quota: Prisma.Decimal | null; total: Prisma.Decimal | null; retention: Prisma.Decimal | null } };

/** Totals of a materialised book from groupBy(rate) + aggregate over the WHOLE range — never from the page rows. */
function summaryFromGroups(groups: readonly VatRateGroup[], totals: VatRateGroup["_sum"], filas: number): VatBookSummary {
  return {
    filas,
    base: toWire(totals.base ?? ZERO),
    cuota: toWire(totals.quota ?? ZERO),
    total: toWire(totals.total ?? ZERO),
    retencion: toWire(totals.retention ?? ZERO),
    porTipo: [...groups]
      .sort((a, b) => b.rate.comparedTo(a.rate))
      .map((group) => ({ rate: toWire(group.rate), filas: group._count._all, base: toWire(group._sum.base ?? ZERO), cuota: toWire(group._sum.quota ?? ZERO), total: toWire(group._sum.total ?? ZERO), retencion: toWire(group._sum.retention ?? ZERO) }))
  };
}

/**
 * Libro de IVA paged (Tanda L2 · L2-05). A materialised book (VatBookEntry
 * rows in the range) is a keyset page on (date, id) with `total` and the
 * per-rate totals computed by groupBy / aggregate over the whole range; a
 * book without materialised rows is derived from the documents in memory
 * (as before), bounded to `limit` rows with no cursor (`avisos` says how to
 * materialise it with POST /fiscal/vat-books/rebuild).
 */
export async function listVatBook(input: { context: UserContext; book: VatBookName; period?: string; from?: string; to?: string; propertyId?: string | null; limit?: number; cursor?: string | null }): Promise<VatBookPage> {
  requirePermissions(input.context, ["accounting.read"]);
  // R11: the whole-sociedad book needs accounting.entity.read; a centre view, that centre.
  assertFinanceReadScope(input.context, input.propertyId ?? null);
  const organizationId = input.context.organizationId;
  const settings = await getVatSettings(organizationId);
  let periodo: FiscalPeriodDto;
  if (input.period) {
    periodo = parseFiscalPeriod(input.period);
  } else if (input.from && input.to) {
    if (!isIsoDay(input.from) || !isIsoDay(input.to) || input.from > input.to) {
      throw new BadRequestError("Indica un rango de fechas válido (from ≤ to, formato YYYY-MM-DD).");
    }
    periodo = periodFromRange(input.from, input.to) ?? { code: `${input.from}_${input.to}`, type: "quarterly", year: Number(input.from.slice(0, 4)), quarter: null, month: null, from: input.from, to: input.to, aeatPeriod: "" };
  } else {
    throw new BadRequestError("Indica period (2026-Q3 · 2026-09 · 2026) o from y to.");
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? VAT_BOOK_PAGE_LIMIT), 1), VAT_BOOK_PAGE_LIMIT);
  const cursor = decodeCursor(input.cursor ?? null);
  if (cursor && !isIsoDay(cursor.k)) throw new BadRequestError("El cursor de paginación no es válido.");
  const filter: Prisma.VatBookEntryWhereInput = {
    organizationId,
    book: input.book,
    date: { gte: dateColumn(periodo.from), lte: dateColumn(periodo.to) },
    ...(input.propertyId ? { propertyId: input.propertyId } : {})
  };
  const total = await prisma.vatBookEntry.count({ where: filter });
  if (total > 0) {
    const where: Prisma.VatBookEntryWhereInput = cursor ? { AND: [filter, { OR: [{ date: { gt: dateColumn(cursor.k) } }, { date: dateColumn(cursor.k), id: { gt: cursor.id } }] }] } : filter;
    const [rows, groups, totals] = await Promise.all([
      prisma.vatBookEntry.findMany({ where, orderBy: [{ date: "asc" }, { id: "asc" }], take: limit + 1 }),
      prisma.vatBookEntry.groupBy({ by: ["rate"], where: filter, _count: { _all: true }, _sum: { base: true, quota: true, total: true, retention: true } }),
      prisma.vatBookEntry.aggregate({ where: filter, _sum: { base: true, quota: true, total: true, retention: true } })
    ]);
    const page = buildPage(rows, limit, total, (row) => dateColumnDay(row.date));
    return {
      organizationId,
      propertyId: input.propertyId ?? null,
      book: input.book,
      periodo,
      origen: "libros",
      rows: page.items.map((row) => toVatBookRowDto(fromPersistedRow(row))),
      resumen: summaryFromGroups(groups, totals._sum, total),
      avisos: [],
      total,
      nextCursor: page.nextCursor
    };
  }
  const loaded = await loadVatBookRows({ organizationId, from: periodo.from, to: periodo.to, propertyId: input.propertyId, periodicity: settings.periodicity, taxFigure: settings.taxFigure, books: [input.book] });
  const avisos = [...loaded.avisos];
  // FIX-1 · F3 (E-03): a centre view over a Sage period is empty because the imported rows carry no centre.
  if (input.propertyId && loaded.rows.length === 0 && (await countSageRowsWithoutCentre(organizationId, periodo.from, periodo.to)) > 0) avisos.push(SAGE_NO_CENTRE_AVISO);
  if (loaded.rows.length > limit) {
    avisos.push(`El libro calculado desde los documentos tiene ${loaded.rows.length} filas y se muestran las primeras ${limit}: materialízalo con POST /fiscal/vat-books/rebuild para paginarlo.`);
  }
  return {
    organizationId,
    propertyId: input.propertyId ?? null,
    book: input.book,
    periodo,
    origen: loaded.origen[input.book],
    rows: loaded.rows.slice(0, limit).map(toVatBookRowDto),
    resumen: summarizeVatRows(loaded.rows),
    avisos,
    total: loaded.rows.length,
    nextCursor: null
  };
}
