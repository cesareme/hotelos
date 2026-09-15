// Fixed assets · inmovilizado (Finanzas 2026-09-15, lote proveedores-activos).
//
// FixedAsset rows carry their PGC accounts (21x/20x asset, 28xx accumulated,
// 681/680 expense) and the annual coefficient, capped by the maximum of the
// tablas del art. 12 LIS for the category (mobiliario 10 %, instalaciones
// 10 %, equipos informáticos 25 %, construcciones 3 %, vehículos 16 %). An
// asset is born from a supplier-bill line marked as investment good (the
// acquisition entry is the bill's: D 21x / D 472 / H 400) or registered by
// hand (legacy / pre-existing elements, no acquisition entry). Disposal:
// D 28xx (accumulated) / D 671 (loss) [/ D 572|570|430 sale] / H 21x (cost)
// [/ H 771 gain]. Monthly depreciation lives in depreciation.service.ts.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { getLedgerPort, type LedgerEntryResult, type LedgerLineInput } from "../payables/ledger-port.js";
import { dayInput, dayOf, dec, money, moneyInput, percentInput, round2, ZERO, type Decimal } from "../payables/money.js";

type Tx = Prisma.TransactionClient;

export const ASSET_CATEGORIES = ["mobiliario", "instalaciones", "informatica", "construcciones", "vehiculos", "intangible", "otro"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/** Maximum annual coefficient (%) per category — tablas del art. 12.1.a) LIS (intangible: sistemas y programas informáticos 33 %; otro: utillaje 25 %, the highest of its accounts). */
export const LIS_MAX_COEFFICIENT_PCT: Record<AssetCategory, string> = {
  mobiliario: "10",
  instalaciones: "10",
  informatica: "25",
  construcciones: "3",
  vehiculos: "16",
  intangible: "33",
  otro: "25"
};

export type AssetAccountDefaults = {
  category: AssetCategory;
  /** Default annual coefficient (%) of the account (LIS table); "0" = not depreciable (terrenos). */
  coefficientPct: string;
  depreciationAccountCode: string;
  expenseAccountCode: string;
};

/** Defaults by 3-digit asset account (PGC Pymes 20x/21x). */
export const ASSET_ACCOUNT_DEFAULTS: Record<string, AssetAccountDefaults> = Object.freeze({
  "203": { category: "intangible", coefficientPct: "10", depreciationAccountCode: "280", expenseAccountCode: "680" },
  "206": { category: "intangible", coefficientPct: "33", depreciationAccountCode: "2806", expenseAccountCode: "680" },
  "210": { category: "otro", coefficientPct: "0", depreciationAccountCode: "2819", expenseAccountCode: "681" },
  "211": { category: "construcciones", coefficientPct: "3", depreciationAccountCode: "2811", expenseAccountCode: "681" },
  "212": { category: "instalaciones", coefficientPct: "10", depreciationAccountCode: "2812", expenseAccountCode: "681" },
  "213": { category: "otro", coefficientPct: "12", depreciationAccountCode: "2813", expenseAccountCode: "681" },
  "214": { category: "otro", coefficientPct: "25", depreciationAccountCode: "2814", expenseAccountCode: "681" },
  "215": { category: "instalaciones", coefficientPct: "10", depreciationAccountCode: "2815", expenseAccountCode: "681" },
  "216": { category: "mobiliario", coefficientPct: "10", depreciationAccountCode: "2816", expenseAccountCode: "681" },
  "217": { category: "informatica", coefficientPct: "25", depreciationAccountCode: "2817", expenseAccountCode: "681" },
  "218": { category: "vehiculos", coefficientPct: "16", depreciationAccountCode: "2818", expenseAccountCode: "681" },
  "219": { category: "otro", coefficientPct: "10", depreciationAccountCode: "2819", expenseAccountCode: "681" }
});

/** Default asset account per category (the reverse of the table above). */
export const CATEGORY_ACCOUNT_DEFAULTS: Record<AssetCategory, string> = {
  mobiliario: "216",
  instalaciones: "212",
  informatica: "217",
  construcciones: "211",
  vehiculos: "218",
  intangible: "206",
  otro: "219"
};

/** Defaults for an asset account code ("216", "2160", "216.1" → the 216 row); null for a code outside 20x/21x. */
export function assetDefaultsForAccount(accountCode: string): AssetAccountDefaults | null {
  const digits = accountCode.replace(/[^0-9]/g, "");
  if (digits.length < 3) return null;
  return ASSET_ACCOUNT_DEFAULTS[digits.slice(0, 3)] ?? null;
}

export function maxCoefficientFor(category: AssetCategory): Decimal {
  return dec(LIS_MAX_COEFFICIENT_PCT[category]);
}

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

/** Coefficient ≤ table maximum for the category (400 COEFFICIENT_ABOVE_MAX). */
export function assertCoefficient(category: AssetCategory, coefficientPct: Decimal): Decimal {
  const max = maxCoefficientFor(category);
  if (coefficientPct.gt(max)) {
    throw typed(400, "COEFFICIENT_ABOVE_MAX", `El coeficiente ${coefficientPct.toFixed(2)} % supera el máximo de tablas (art. 12 LIS) para ${category}: ${max.toFixed(2)} %.`, {
      category,
      coefficientPct: coefficientPct.toFixed(2),
      maxCoefficientPct: max.toFixed(2)
    });
  }
  return coefficientPct;
}

const assetBaseSchema = z
  .object({
    name: z.string().trim().min(1, "obligatorio").max(200),
    category: z.enum(ASSET_CATEGORIES).optional(),
    accountCode: z.string().trim().min(3).max(12).optional(),
    depreciationAccountCode: z.string().trim().min(3).max(12).optional(),
    expenseAccountCode: z.string().trim().min(3).max(12).optional(),
    acquisitionDate: dayInput(),
    startDate: dayInput().nullable().optional(),
    acquisitionCost: moneyInput({ allowZero: false }),
    residualValue: moneyInput().optional(),
    coefficientPct: percentInput().optional(),
    usefulLifeMonths: z.number().int().min(1).max(1200).nullable().optional(),
    supplierBillId: z.string().trim().min(1).max(64).nullable().optional(),
    assetId: z.string().trim().min(1).max(64).nullable().optional()
  })
  .strict();

const assetPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    coefficientPct: percentInput().optional(),
    residualValue: moneyInput().optional(),
    startDate: dayInput().nullable().optional(),
    depreciationAccountCode: z.string().trim().min(3).max(12).optional(),
    expenseAccountCode: z.string().trim().min(3).max(12).optional(),
    usefulLifeMonths: z.number().int().min(1).max(1200).nullable().optional(),
    assetId: z.string().trim().min(1).max(64).nullable().optional()
  })
  .strict();

const disposeSchema = z
  .object({
    date: dayInput(),
    /** Net sale price (0 = scrapping / loss of the whole net book value). */
    saleAmount: moneyInput().optional(),
    /**
     * 572 bank (default) · 570 cash · 4300 customer receivable (the ONE
     * customer sub-account every writer uses since fix:ledger t6#4 —
     * `CUSTOMER_ACCOUNT_CODE` in packages/shared/src/accounting-types.ts; 430
     * stays a header of 4300/4304 in the PGC Pymes hotelero template).
     */
    counterAccountCode: z.enum(["572", "570", "4300"]).optional(),
    reason: z.string().trim().max(300).optional()
  })
  .strict();

export type FixedAssetDto = {
  id: string;
  organizationId: string | null;
  propertyId: string;
  name: string;
  category: AssetCategory | null;
  accountCode: string | null;
  depreciationAccountCode: string | null;
  expenseAccountCode: string | null;
  acquisitionDate: string | null;
  startDate: string | null;
  acquisitionCost: string;
  residualValue: string;
  coefficientPct: string | null;
  maxCoefficientPct: string | null;
  /** Full-month quota at the current coefficient (null when not depreciable). */
  monthlyAmount: string | null;
  accumulatedDepreciation: string;
  netBookValue: string;
  status: "active" | "fully_depreciated" | "disposed";
  disposedAt: string | null;
  supplierBillId: string | null;
  assetId: string | null;
  usefulLifeMonths: number | null;
  /** True when the row lacks category / coefficient / accounts and the depreciation run skips it. */
  depreciable: boolean;
  updatedAt: string;
};

export type FixedAssetDetailDto = FixedAssetDto & {
  history: Array<{ runId: string; period: string; status: string; amount: string; accumulatedAfter: string; netBookValueAfter: string }>;
  disposalEntry: LedgerEntryResult | null;
};

export type FixedAssetRow = NonNullable<Awaited<ReturnType<typeof prisma.fixedAsset.findUnique>>>;

/** Monthly straight-line quota at the coefficient: (cost − residual) × coef / 100 / 12, rounded to the cent. */
export function fullMonthQuota(acquisitionCost: Decimal, residualValue: Decimal, coefficientPct: Decimal): Decimal {
  return round2(acquisitionCost.minus(residualValue).times(coefficientPct).div(100).div(12));
}

export function isDepreciable(row: Pick<FixedAssetRow, "category" | "coefficientPct" | "accountCode" | "depreciationAccountCode" | "expenseAccountCode">): boolean {
  return Boolean(row.category && row.coefficientPct !== null && row.coefficientPct !== undefined && !dec(row.coefficientPct).isZero() && row.accountCode && row.depreciationAccountCode && row.expenseAccountCode);
}

export function toFixedAssetDto(row: FixedAssetRow): FixedAssetDto {
  const cost = dec(row.acquisitionCost);
  const residual = dec(row.residualValue);
  const accumulated = dec(row.accumulatedDepreciation);
  const category = (row.category ?? null) as AssetCategory | null;
  const coefficient = row.coefficientPct === null || row.coefficientPct === undefined ? null : dec(row.coefficientPct);
  const depreciable = isDepreciable(row);
  return {
    id: row.id,
    organizationId: row.organizationId ?? null,
    propertyId: row.propertyId,
    name: row.name,
    category,
    accountCode: row.accountCode ?? null,
    depreciationAccountCode: row.depreciationAccountCode ?? null,
    expenseAccountCode: row.expenseAccountCode ?? null,
    acquisitionDate: dayOf(row.acquisitionDate),
    startDate: dayOf(row.startDate ?? row.acquisitionDate),
    acquisitionCost: money(cost),
    residualValue: money(residual),
    coefficientPct: coefficient ? coefficient.toFixed(2) : null,
    maxCoefficientPct: category && category in LIS_MAX_COEFFICIENT_PCT ? dec(LIS_MAX_COEFFICIENT_PCT[category]).toFixed(2) : null,
    monthlyAmount: depreciable && coefficient ? money(fullMonthQuota(cost, residual, coefficient)) : null,
    accumulatedDepreciation: money(accumulated),
    netBookValue: money(cost.minus(accumulated)),
    status: row.status,
    disposedAt: dayOf(row.disposedAt),
    supplierBillId: row.supplierBillId ?? null,
    assetId: row.assetId ?? null,
    usefulLifeMonths: row.usefulLifeMonths ?? null,
    depreciable,
    updatedAt: row.updatedAt.toISOString()
  };
}

async function organizationOfProperty(tx: Tx | typeof prisma, propertyId: string): Promise<string> {
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property.organizationId;
}

async function requireAsset(tx: Tx | typeof prisma, propertyId: string, assetId: string): Promise<FixedAssetRow> {
  const row = await tx.fixedAsset.findFirst({ where: { id: assetId, propertyId } });
  if (!row) throw new NotFoundError("Elemento de inmovilizado no encontrado.");
  return row;
}

async function assertChartAccounts(tx: Tx, organizationId: string, codes: Array<{ code: string; what: string; group: number }>): Promise<void> {
  const unique = Array.from(new Set(codes.map((c) => c.code)));
  const accounts = await tx.account.findMany({ where: { organizationId, code: { in: unique } }, select: { code: true, group: true, isPostable: true } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const { code, what, group } of codes) {
    const account = byCode.get(code);
    if (!account) throw typed(400, "ASSET_ACCOUNT_INVALID", `${what}: la cuenta ${code} no existe en el plan de la organización.`, { accountCode: code });
    if (!account.isPostable) throw typed(400, "ASSET_ACCOUNT_INVALID", `${what}: la cuenta ${code} es una cabecera y no admite apuntes.`, { accountCode: code });
    if (account.group !== group) throw typed(400, "ASSET_ACCOUNT_INVALID", `${what}: la cuenta ${code} debe pertenecer al grupo ${group}.`, { accountCode: code, expectedGroup: group });
  }
}

type ResolvedAssetConfig = {
  category: AssetCategory;
  accountCode: string;
  depreciationAccountCode: string;
  expenseAccountCode: string;
  coefficientPct: Decimal;
};

/** Category / accounts / coefficient from what the caller gave (pure): account wins for the defaults, category for the cap. */
export function resolveAssetConfig(input: { category?: AssetCategory; accountCode?: string; depreciationAccountCode?: string; expenseAccountCode?: string; coefficientPct?: Decimal }): ResolvedAssetConfig {
  if (!input.category && !input.accountCode) throw typed(400, "ASSET_CATEGORY_REQUIRED", "Indica la categoría del elemento o su cuenta de inmovilizado (20x/21x).");
  const accountCode = input.accountCode ?? CATEGORY_ACCOUNT_DEFAULTS[input.category!];
  const defaults = assetDefaultsForAccount(accountCode);
  if (!defaults) throw typed(400, "ASSET_ACCOUNT_INVALID", `La cuenta ${accountCode} no es una cuenta de inmovilizado (20x/21x).`, { accountCode });
  const category = input.category ?? defaults.category;
  const coefficientPct = input.coefficientPct ?? dec(category === defaults.category ? defaults.coefficientPct : LIS_MAX_COEFFICIENT_PCT[category]);
  if (category === "otro" && input.coefficientPct === undefined && !input.accountCode) {
    throw typed(400, "COEFFICIENT_REQUIRED", "La categoría «otro» no tiene coeficiente de tablas: indica coefficientPct.");
  }
  assertCoefficient(category, coefficientPct);
  return {
    category,
    accountCode,
    depreciationAccountCode: input.depreciationAccountCode ?? defaults.depreciationAccountCode,
    expenseAccountCode: input.expenseAccountCode ?? defaults.expenseAccountCode,
    coefficientPct
  };
}

export async function listFixedAssetRegister(filter: { propertyId: string; status?: "active" | "fully_depreciated" | "disposed"; q?: string; limit?: number }): Promise<FixedAssetDto[]> {
  const q = filter.q?.trim();
  const rows = await prisma.fixedAsset.findMany({
    where: {
      propertyId: filter.propertyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {})
    },
    orderBy: [{ status: "asc" }, { acquisitionDate: "desc" }, { name: "asc" }],
    take: Math.min(Math.max(filter.limit ?? 200, 1), 500)
  });
  return rows.map(toFixedAssetDto);
}

export async function getFixedAsset(propertyId: string, assetId: string): Promise<FixedAssetDetailDto> {
  const row = await requireAsset(prisma, propertyId, assetId);
  const lines = await prisma.depreciationLine.findMany({ where: { fixedAssetId: row.id }, include: { run: { select: { id: true, period: true, status: true } } }, orderBy: { run: { period: "asc" } } });
  const organizationId = row.organizationId ?? (await organizationOfProperty(prisma, propertyId));
  const disposal = row.status === "disposed" ? await prisma.journalEntry.findFirst({ where: { organizationId, sourceType: "fixed_asset_disposal", sourceId: row.id }, select: { id: true } }) : null;
  const disposalEntry = disposal ? await prisma.$transaction((tx) => loadEntryDto(tx, organizationId, disposal.id)) : null;
  return {
    ...toFixedAssetDto(row),
    history: lines.map((l) => ({ runId: l.run.id, period: l.run.period, status: l.run.status, amount: money(l.amount), accumulatedAfter: money(l.accumulatedAfter), netBookValueAfter: money(l.netBookValueAfter) })),
    disposalEntry
  };
}

export async function loadEntryDto(tx: Tx, organizationId: string, journalEntryId: string): Promise<LedgerEntryResult | null> {
  const entry = await tx.journalEntry.findFirst({ where: { id: journalEntryId, organizationId } });
  if (!entry) return null;
  const rows = await tx.journalLine.findMany({ where: { journalEntryId }, orderBy: { id: "asc" } });
  let totalDebit = ZERO;
  let totalCredit = ZERO;
  for (const r of rows) {
    totalDebit = totalDebit.plus(r.debit);
    totalCredit = totalCredit.plus(r.credit);
  }
  return {
    id: entry.id,
    entryNumber: entry.entryNumber ?? null,
    fiscalYearCode: entry.fiscalYearCode ?? null,
    entryDate: entry.entryDate.toISOString().slice(0, 10),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId ?? null,
    description: entry.description ?? null,
    reference: entry.reference ?? null,
    status: entry.status,
    reversalOfId: entry.reversalOfId ?? null,
    reversedById: entry.reversedById ?? null,
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
    lines: rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      accountCode: r.accountCode ?? r.accountId,
      debit: money(r.debit),
      credit: money(r.credit),
      description: r.description ?? null,
      taxRateCode: r.taxRateCode ?? null,
      taxBase: r.taxBase === null || r.taxBase === undefined ? null : money(r.taxBase),
      costCenterId: r.costCenterId ?? null
    })),
    alreadyExisted: true
  };
}

type CommandInput = { context: UserContext; propertyId: string; correlationId: string };

export async function createFixedAsset(input: CommandInput & { body: unknown }): Promise<FixedAssetDto> {
  const data = parseOr400(assetBaseSchema, input.body ?? {}, "Elemento de inmovilizado");
  const organizationId = await organizationOfProperty(prisma, input.propertyId);
  const config = resolveAssetConfig(data);
  const residual = data.residualValue ?? ZERO;
  if (residual.gte(data.acquisitionCost)) throw typed(400, "RESIDUAL_ABOVE_COST", "El valor residual debe ser inferior al coste de adquisición.");
  const startDate = data.startDate ?? data.acquisitionDate;
  if (startDate < data.acquisitionDate) throw typed(400, "START_BEFORE_ACQUISITION", "La puesta en funcionamiento no puede ser anterior a la adquisición.");
  const row = await prisma.$transaction(async (tx) => {
    await assertChartAccounts(tx, organizationId, [
      { code: config.accountCode, what: "Cuenta de inmovilizado", group: 2 },
      { code: config.depreciationAccountCode, what: "Cuenta de amortización acumulada", group: 2 },
      { code: config.expenseAccountCode, what: "Cuenta de dotación", group: 6 }
    ]);
    if (data.supplierBillId) {
      const bill = await tx.supplierBill.findFirst({ where: { id: data.supplierBillId, propertyId: input.propertyId }, select: { id: true } });
      if (!bill) throw new NotFoundError("Factura recibida no encontrada.");
    }
    return tx.fixedAsset.create({
      data: {
        propertyId: input.propertyId,
        organizationId,
        assetId: data.assetId ?? null,
        name: data.name,
        acquisitionDate: data.acquisitionDate,
        acquisitionCost: data.acquisitionCost,
        depreciationMethod: "linear",
        usefulLifeMonths: data.usefulLifeMonths ?? null,
        accumulatedDepreciation: ZERO,
        category: config.category,
        accountCode: config.accountCode,
        depreciationAccountCode: config.depreciationAccountCode,
        expenseAccountCode: config.expenseAccountCode,
        coefficientPct: config.coefficientPct,
        startDate,
        residualValue: residual,
        status: "active",
        supplierBillId: data.supplierBillId ?? null
      }
    });
  });
  const dto = toFixedAssetDto(row);
  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FIXED_ASSET_REGISTERED",
    entityType: "fixed_asset",
    entityId: dto.id,
    afterJson: { name: dto.name, category: dto.category, accountCode: dto.accountCode, acquisitionCost: dto.acquisitionCost, coefficientPct: dto.coefficientPct },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId,
    propertyId: input.propertyId,
    entityType: "fixed_asset",
    entityId: dto.id,
    eventType: "FixedAssetRegistered",
    payload: { name: dto.name, category: dto.category, acquisitionCost: dto.acquisitionCost, coefficientPct: dto.coefficientPct, supplierBillId: dto.supplierBillId },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return dto;
}

/** Asset born from a supplier-bill line marked as investment good (called inside the bill's posting transaction). */
export async function registerFixedAssetFromBillLine(tx: Tx, input: { organizationId: string; propertyId: string; supplierBillId: string; name: string; accountCode: string; acquisitionDate: Date; acquisitionCost: Decimal }): Promise<{ id: string }> {
  const config = resolveAssetConfig({ accountCode: input.accountCode });
  await assertChartAccounts(tx, input.organizationId, [
    { code: config.accountCode, what: "Cuenta de inmovilizado", group: 2 },
    { code: config.depreciationAccountCode, what: "Cuenta de amortización acumulada", group: 2 },
    { code: config.expenseAccountCode, what: "Cuenta de dotación", group: 6 }
  ]);
  const row = await tx.fixedAsset.create({
    data: {
      propertyId: input.propertyId,
      organizationId: input.organizationId,
      name: input.name,
      acquisitionDate: input.acquisitionDate,
      acquisitionCost: input.acquisitionCost,
      depreciationMethod: "linear",
      accumulatedDepreciation: ZERO,
      category: config.category,
      accountCode: config.accountCode,
      depreciationAccountCode: config.depreciationAccountCode,
      expenseAccountCode: config.expenseAccountCode,
      coefficientPct: config.coefficientPct,
      startDate: input.acquisitionDate,
      residualValue: ZERO,
      status: "active",
      supplierBillId: input.supplierBillId
    },
    select: { id: true }
  });
  return row;
}

export async function updateFixedAsset(input: CommandInput & { assetId: string; body: unknown }): Promise<FixedAssetDto> {
  const data = parseOr400(assetPatchSchema, input.body ?? {}, "Elemento de inmovilizado");
  const row = await prisma.$transaction(async (tx) => {
    const before = await requireAsset(tx, input.propertyId, input.assetId);
    if (before.status === "disposed") throw typed(409, "ASSET_DISPOSED", "El elemento está dado de baja y no admite cambios.");
    const organizationId = before.organizationId ?? (await organizationOfProperty(tx, input.propertyId));
    const category = (before.category ?? "otro") as AssetCategory;
    const patch: Prisma.FixedAssetUpdateInput = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.assetId !== undefined) patch.assetId = data.assetId;
    if (data.usefulLifeMonths !== undefined) patch.usefulLifeMonths = data.usefulLifeMonths;
    if (data.coefficientPct !== undefined) patch.coefficientPct = assertCoefficient(category, data.coefficientPct);
    if (data.residualValue !== undefined) {
      if (data.residualValue.gte(dec(before.acquisitionCost))) throw typed(400, "RESIDUAL_ABOVE_COST", "El valor residual debe ser inferior al coste de adquisición.");
      if (data.residualValue.gt(dec(before.acquisitionCost).minus(dec(before.accumulatedDepreciation)))) {
        throw typed(400, "RESIDUAL_ABOVE_NBV", "El valor residual no puede superar el valor neto contable ya amortizado.");
      }
      patch.residualValue = data.residualValue;
    }
    const hasHistory = !dec(before.accumulatedDepreciation).isZero();
    if (data.startDate !== undefined) {
      if (hasHistory) throw typed(409, "ASSET_HAS_DEPRECIATION", "No se puede cambiar la fecha de inicio de un elemento con amortización contabilizada.");
      patch.startDate = data.startDate;
    }
    const codes: Array<{ code: string; what: string; group: number }> = [];
    if (data.depreciationAccountCode !== undefined) {
      if (hasHistory) throw typed(409, "ASSET_HAS_DEPRECIATION", "No se puede cambiar la cuenta de amortización acumulada de un elemento con amortización contabilizada.");
      codes.push({ code: data.depreciationAccountCode, what: "Cuenta de amortización acumulada", group: 2 });
      patch.depreciationAccountCode = data.depreciationAccountCode;
    }
    if (data.expenseAccountCode !== undefined) {
      codes.push({ code: data.expenseAccountCode, what: "Cuenta de dotación", group: 6 });
      patch.expenseAccountCode = data.expenseAccountCode;
    }
    if (codes.length) await assertChartAccounts(tx, organizationId, codes);
    return tx.fixedAsset.update({ where: { id: before.id }, data: patch });
  });
  const dto = toFixedAssetDto(row);
  recordAuditEvent({
    organizationId: dto.organizationId ?? input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FIXED_ASSET_UPDATED",
    entityType: "fixed_asset",
    entityId: dto.id,
    afterJson: { name: dto.name, coefficientPct: dto.coefficientPct, residualValue: dto.residualValue, startDate: dto.startDate },
    correlationId: input.correlationId
  });
  return dto;
}

/** Journal lines of a disposal (pure): D 28xx accumulated / D 671 loss / [D counter sale] / H 21x cost / [H 771 gain]. */
export function buildDisposalLines(input: { name: string; accountCode: string; depreciationAccountCode: string; acquisitionCost: Decimal; accumulatedDepreciation: Decimal; saleAmount: Decimal; counterAccountCode: string }): LedgerLineInput[] {
  const netBookValue = input.acquisitionCost.minus(input.accumulatedDepreciation);
  const result = input.saleAmount.minus(netBookValue);
  const lines: LedgerLineInput[] = [];
  if (!input.accumulatedDepreciation.isZero()) lines.push({ accountCode: input.depreciationAccountCode, debit: input.accumulatedDepreciation, description: `Baja amortización acumulada ${input.name}` });
  if (result.isNegative()) lines.push({ accountCode: "671", debit: result.abs(), description: `Pérdida por baja ${input.name}` });
  if (!input.saleAmount.isZero()) lines.push({ accountCode: input.counterAccountCode, debit: input.saleAmount, description: `Venta ${input.name}` });
  lines.push({ accountCode: input.accountCode, credit: input.acquisitionCost, description: `Baja ${input.name}` });
  if (result.gt(ZERO)) lines.push({ accountCode: "771", credit: result, description: `Beneficio por venta ${input.name}` });
  return lines;
}

export async function disposeFixedAsset(input: CommandInput & { assetId: string; body: unknown }): Promise<FixedAssetDetailDto> {
  const data = parseOr400(disposeSchema, input.body ?? {}, "Baja de inmovilizado");
  const saleAmount = data.saleAmount ?? ZERO;
  const counterAccountCode = data.counterAccountCode ?? "572";
  const result = await prisma.$transaction(async (tx) => {
    const before = await requireAsset(tx, input.propertyId, input.assetId);
    if (before.status === "disposed") return { row: before, entry: null as LedgerEntryResult | null };
    const organizationId = before.organizationId ?? (await organizationOfProperty(tx, input.propertyId));
    if (!before.accountCode || !before.depreciationAccountCode) {
      throw typed(409, "ASSET_NOT_CONFIGURED", "El elemento no tiene cuentas de inmovilizado/amortización: complétalas antes de darlo de baja.");
    }
    if (before.acquisitionDate && data.date < before.acquisitionDate) throw typed(400, "DISPOSAL_BEFORE_ACQUISITION", "La fecha de baja no puede ser anterior a la adquisición.");
    const entry = await getLedgerPort().post(tx, {
      organizationId,
      propertyId: input.propertyId,
      entryDate: data.date,
      sourceType: "fixed_asset_disposal",
      sourceId: before.id,
      description: `Baja inmovilizado ${before.name}${data.reason ? `: ${data.reason}` : ""}`,
      reference: null,
      createdBy: input.context.userId,
      lines: buildDisposalLines({
        name: before.name,
        accountCode: before.accountCode,
        depreciationAccountCode: before.depreciationAccountCode,
        acquisitionCost: dec(before.acquisitionCost),
        accumulatedDepreciation: dec(before.accumulatedDepreciation),
        saleAmount,
        counterAccountCode
      })
    });
    const row = await tx.fixedAsset.update({ where: { id: before.id }, data: { status: "disposed", disposedAt: data.date } });
    return { row, entry };
  });
  const dto = await getFixedAsset(input.propertyId, result.row.id);
  if (result.entry) {
    recordAuditEvent({
      organizationId: dto.organizationId ?? input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "FIXED_ASSET_DISPOSED",
      entityType: "fixed_asset",
      entityId: dto.id,
      afterJson: { status: dto.status, disposedAt: dto.disposedAt, saleAmount: money(saleAmount), journalEntryId: result.entry.id },
      correlationId: input.correlationId
    });
    recordDomainEvent({
      organizationId: dto.organizationId ?? input.context.organizationId,
      propertyId: input.propertyId,
      entityType: "fixed_asset",
      entityId: dto.id,
      eventType: "FixedAssetDisposed",
      payload: { saleAmount: money(saleAmount), netBookValue: dto.netBookValue, journalEntryId: result.entry.id, date: dto.disposedAt },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }
  return dto;
}

export { assetBaseSchema as createFixedAssetSchema, assetPatchSchema as updateFixedAssetSchema, disposeSchema as disposeFixedAssetSchema };
