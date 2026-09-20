// Activo inmobiliario · tributos locales, recibos, calendario y asiento 631
// propuesto (Tanda ACT · L2, diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md
// §5 «Tributos», §5.1 estados, §6 contabilidad, §7 API).
//
// Decisión del brief: tributos como registros MANUALES con asiento propuesto en
// BORRADOR, nunca contabilizado automáticamente. Por cada `PropertyTax` activo
// el módulo genera los `PropertyTaxReceipt` `previsto` del ejercicio
// (`expectedReceiptsFor` de tax-calendar.ts; idempotente por
// @@unique([taxId, fiscalYear, period])) → llega el recibo (importe, ventana,
// documento) → `recibido` | `domiciliado` → `pagado` (paidAt / paidWith) →
// «Proponer asiento»: `createJournalEntryDraft` (accounting.service.ts) crea un
// JournalEntry `draft` con sourceType `property_tax_receipt` y el recibo guarda
// `journalEntryId`; el contable lo contabiliza con POST /journal-entries/:id/post.
// NUNCA se llama a postJournalEntry ni a createExpense. «Recurrir» vale desde
// cualquier estado, también `pagado` (conserva paidAt / paidWith; máquina
// RECEIPT de state-machines.ts; 409 `RECEIPT_NOT_PAYABLE`) y no impide pagar;
// `vencido` es derivado (`overdue`: sin pagar y `dueTo` anterior a hoy).
//
// Asiento y estado (ACT-REV-03 / REV-04): desenlazar (`journalEntryId: null`) un
// borrador PROPIO (sourceType property_tax_receipt + sourceId = recibo) lo
// descarta (líneas + cabecera; nunca se numeró) para que «volver a proponer» no
// deje borradores huérfanos; desenlazar un asiento propio ya `posted` responde
// 409 RECEIPT_ENTRY_EXISTS (primero reverseJournalEntry). Al pasar a `pagado`
// con borrador propio enlazado, el borrador se REGENERA (H 57x según paidWith en
// vez de H 475); con asiento propio `posted` con H 475 se propone el asiento de
// pago (D 475 / H 57x, sourceType property_tax_receipt_payment) como segundo
// borrador. `propose-entry` rechaza además cualquier asiento no anulado del
// mismo recibo por (organización, sourceType, sourceId).
//
// Asiento (§6): D `tax.accountCode` (631 «Otros tributos»; 231 «Construcciones en
// curso» para el ICIO capitalizable) por amount + surchargeAmount / H 570 · 5721 ·
// 572 según `paidWith` (RECEIPT_COUNTER_ACCOUNTS, copia de
// EXPENSE_COUNTER_ACCOUNTS de payables/expenses.service.ts) si el recibo está
// pagado, o H 475 «Hacienda Pública, acreedora por conceptos fiscales» si está
// recibido / domiciliado / recurrido. Concepto «IBI 2026 · <Property.code> ·
// <fiscalReference>»; el centro va en `propertyId` del asiento. Solo con
// `taxpayer = sociedad` (409 `TAXPAYER_NOT_ENTITY`) y una sola vez (409
// `RECEIPT_ENTRY_EXISTS`); un `previsto` o un recibo sin importe no se propone
// (409 `RECEIPT_NOT_PAYABLE`). El 409 FISCAL_YEAR_CLOSED del motor se propaga
// tal cual. Enlace manual: PATCH …/receipts/:id { journalEntryId } admite un
// asiento `posted` de la misma organización y centro (ejercicios cerrados).
//
// Tenencia: toda ruta cuelga de /properties/:propertyId/*; cada fila se busca
// SIEMPRE a través del activo del centro (`tax.propertyId`) y responde 404
// opaco. Auditoría con recordAuditEvent en toda escritura (entityType
// property_tax / property_tax_receipt). Los mapeadores, el constructor del
// asiento y el calendario son puros y van exportados para el test unitario
// (__tests__/property-tax.test.mts, sin BD).

import { prisma } from "@hotelos/database";
import { Prisma, type PropertyTax, type PropertyTaxReceipt } from "@prisma/client";
import type {
  IsoDay,
  MoneyString,
  PropertyTaxInstallment,
  PropertyTaxKind,
  PropertyTaxPaidWith,
  PropertyTaxPeriodicity,
  PropertyTaxReceiptRecord,
  PropertyTaxReceiptStatus,
  PropertyTaxRecord,
  PropertyTaxStatus,
  PropertyTaxTaxpayer,
  RealEstateCalendarEvent,
  RealEstateJournalEntryStatus
} from "@hotelos/shared";
import { z } from "zod";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import {
  PropertyTaxCreateSchema,
  PropertyTaxListQuerySchema,
  PropertyTaxPatchSchema,
  PropertyTaxReceiptCreateSchema,
  PropertyTaxReceiptPatchSchema,
  REAL_ESTATE_MAX_YEAR,
  REAL_ESTATE_MIN_YEAR,
  RealEstateYearQuerySchema,
  type PropertyTaxInstallmentInput
} from "../../schemas/real-estate.schemas.js";
import { createJournalEntryDraft, type JournalEntryDraft, type JournalLineDraft } from "../accounting/accounting.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { dec, money, utcDay, type Decimal } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { PROPERTY_TAX_KIND_LABELS, type AlertReceiptInput } from "./alerts.pure.js";
import { realEstateError } from "./errors.js";
import { definedFields, isoDayOrNull, moneyOrNull, requireRealEstateAsset, requireRealEstateUnit, type RealEstateCommandInput } from "./real-estate.service.js";
import { assertTransition } from "./state-machines.js";
import { expectedReceiptsFor, type ExpectedReceipt, type ExpectedReceiptTaxInput } from "./tax-calendar.js";
import { formatDay, isReceiptOverdue, isReceiptPaid, toIsoDay } from "./vigencias.js";

type Db = Prisma.TransactionClient | typeof prisma;

const UNIQUE_VIOLATION = "P2002";
const isUniqueViolation = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

// ---------------------------------------------------------------------------
// Cuentas (§6)
// ---------------------------------------------------------------------------

/** Copia de EXPENSE_COUNTER_ACCOUNTS (payables/expenses.service.ts): cash → 570, card → 5721, bank → 572. */
export const RECEIPT_COUNTER_ACCOUNTS: Record<PropertyTaxPaidWith, string> = { cash: "570", card: "5721", bank: "572" };
/** Recibo recibido / domiciliado / recurrido sin pagar: deuda con la administración. */
export const TAX_LIABILITY_ACCOUNT = "475";
/** «Otros tributos». */
export const DEFAULT_TAX_ACCOUNT = "631";
/** «Construcciones en curso»: ICIO capitalizable (§6; la cuenta 21x definitiva la fija la capitalización de la obra). */
export const CAPITALIZABLE_TAX_ACCOUNT = "231";
/** Contrapartida cuando el recibo está pagado sin `paidWith` (domiciliación bancaria). */
export const DEFAULT_PAID_WITH: PropertyTaxPaidWith = "bank";
export const RECEIPT_ENTRY_SOURCE_TYPE = "property_tax_receipt";
/** Asiento de pago propuesto cuando el asiento del recibo (H 475) ya está contabilizado y el recibo pasa a pagado. */
export const RECEIPT_PAYMENT_ENTRY_SOURCE_TYPE = "property_tax_receipt_payment";

/** Cuenta por defecto al dar de alta un tributo: 231 para el ICIO capitalizable, 631 en el resto. */
export function defaultTaxAccountCode(kind: PropertyTaxKind, capitalizable: boolean): string {
  return kind === "icio" && capitalizable ? CAPITALIZABLE_TAX_ACCOUNT : DEFAULT_TAX_ACCOUNT;
}

/** Cuenta del debe del asiento: la del tributo; un ICIO capitalizable que aún lleva el 631 por defecto va al 231. */
export function receiptDebitAccount(tax: { kind: PropertyTaxKind | string; capitalizable: boolean; accountCode: string }): string {
  if (tax.kind === "icio" && tax.capitalizable && tax.accountCode === DEFAULT_TAX_ACCOUNT) return CAPITALIZABLE_TAX_ACCOUNT;
  return tax.accountCode;
}

// ---------------------------------------------------------------------------
// DTOs compuestos de L2 (los planos viven en packages/shared/src/real-estate-types.ts)
// ---------------------------------------------------------------------------

export type PropertyTaxWithReceipts = PropertyTaxRecord & { receipts: PropertyTaxReceiptRecord[] };

export type PropertyTaxReceiptListItem = PropertyTaxReceiptRecord & {
  tax: Pick<PropertyTaxRecord, "id" | "kind" | "taxpayer" | "authorityName" | "fiscalReference" | "accountCode" | "status">;
};

export type PropertyTaxReceiptsGenerated = {
  year: number;
  /** Recibos `previsto` creados en esta llamada (vacío si ya existían todos). */
  created: PropertyTaxReceiptRecord[];
  /** Periodos del calendario que ya tenían recibo (no se tocan). */
  existing: number;
  /** Todos los recibos del ejercicio tras la generación. */
  receipts: PropertyTaxReceiptRecord[];
};

/** Periodo del calendario del ejercicio sin recibo generado todavía. */
export type PropertyTaxPendingPeriod = {
  taxId: string;
  kind: PropertyTaxKind;
  period: string;
  dueFrom: IsoDay;
  dueTo: IsoDay;
  amount: MoneyString | null;
};

export type PropertyTaxCalendar = {
  year: number;
  events: RealEstateCalendarEvent[];
  pending: PropertyTaxPendingPeriod[];
};

/** Asiento propuesto (puro): lo que se entrega a createJournalEntryDraft. */
export type ReceiptEntryProposal = {
  entryDate: IsoDay;
  description: string;
  reference: string | undefined;
  lines: JournalLineDraft[];
  total: MoneyString;
  debitAccountCode: string;
  creditAccountCode: string;
};

// ---------------------------------------------------------------------------
// Conversión y mapeadores (fila Prisma → DTO)
// ---------------------------------------------------------------------------

/** `ratePct` es Decimal(8,4) (IBI 0,4-1,3 %): se expone con 4 decimales para no perder el tipo. */
function rateOrNull(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : dec(value).toFixed(4);
}

function percentOrNull(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : dec(value).toFixed(2);
}

/** `installmentsJson` tal cual (la forma la valida el esquema zod al escribir). */
export function installmentsOf(value: Prisma.JsonValue | null | undefined): PropertyTaxInstallment[] | null {
  return Array.isArray(value) ? (value as unknown as PropertyTaxInstallment[]) : null;
}

/** Plazos validados por zod (`pct` Decimal) → JSON plano `{ label, dueFrom, dueTo, pct: "33.33" }`; null borra; undefined no toca. */
export function installmentsJsonInput(items: PropertyTaxInstallmentInput[] | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (items === undefined) return undefined;
  if (items === null) return Prisma.JsonNull;
  return items.map((item) => ({ label: item.label, dueFrom: item.dueFrom, dueTo: item.dueTo, pct: dec(item.pct).toFixed(2) }));
}

export function toPropertyTaxRecord(row: PropertyTax): PropertyTaxRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    assetId: row.assetId,
    unitId: row.unitId ?? null,
    kind: row.kind as PropertyTaxKind,
    taxpayer: row.taxpayer as PropertyTaxTaxpayer,
    authorityName: row.authorityName,
    ineMunicipalityCode: row.ineMunicipalityCode ?? null,
    fiscalReference: row.fiscalReference ?? null,
    taxBase: moneyOrNull(row.taxBase),
    ratePct: rateOrNull(row.ratePct),
    expectedAnnualAmount: moneyOrNull(row.expectedAnnualAmount),
    periodicity: row.periodicity as PropertyTaxPeriodicity,
    voluntaryFrom: row.voluntaryFrom ?? null,
    voluntaryTo: row.voluntaryTo ?? null,
    directDebit: row.directDebit,
    directDebitBonusPct: percentOrNull(row.directDebitBonusPct),
    installmentsJson: installmentsOf(row.installmentsJson),
    accountCode: row.accountCode,
    capitalizable: row.capitalizable,
    legalBasis: row.legalBasis ?? null,
    status: row.status as PropertyTaxStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toPropertyTaxReceiptRecord(row: PropertyTaxReceipt, today: IsoDay, journalEntryStatus: RealEstateJournalEntryStatus | null): PropertyTaxReceiptRecord {
  const dueTo = isoDayOrNull(row.dueTo);
  return {
    id: row.id,
    taxId: row.taxId,
    fiscalYear: row.fiscalYear,
    period: row.period,
    issuedAt: isoDayOrNull(row.issuedAt),
    dueFrom: isoDayOrNull(row.dueFrom),
    dueTo,
    amount: money(row.amount),
    surchargeAmount: money(row.surchargeAmount),
    status: row.status as PropertyTaxReceiptStatus,
    paidAt: isoDayOrNull(row.paidAt),
    paidWith: (row.paidWith ?? null) as PropertyTaxPaidWith | null,
    journalEntryId: row.journalEntryId ?? null,
    journalEntryStatus: row.journalEntryId ? journalEntryStatus : null,
    capexProjectId: row.capexProjectId ?? null,
    documentId: row.documentId ?? null,
    appealRef: row.appealRef ?? null,
    notes: row.notes ?? null,
    overdue: isReceiptOverdue({ status: row.status, dueTo, paidAt: isoDayOrNull(row.paidAt) }, today),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Proyección de un recibo para el motor de alertas (alerts.pure.ts): sin datos personales. */
export function receiptAlertInput(row: PropertyTaxReceipt, taxKind: PropertyTaxKind, propertyId: string): AlertReceiptInput {
  const amount = dec(row.amount).plus(row.surchargeAmount);
  return {
    id: row.id,
    propertyId,
    taxKind,
    fiscalYear: row.fiscalYear,
    period: row.period,
    status: row.status,
    dueTo: isoDayOrNull(row.dueTo),
    amount: amount.gt(0) ? money(amount) : null
  };
}

/** Entrada de `expectedReceiptsFor` a partir de una fila del tributo. */
export function expectedReceiptInputOf(tax: PropertyTax): ExpectedReceiptTaxInput {
  return {
    kind: tax.kind as PropertyTaxKind,
    periodicity: tax.periodicity as PropertyTaxPeriodicity,
    installmentsJson: installmentsOf(tax.installmentsJson),
    expectedAnnualAmount: moneyOrNull(tax.expectedAnnualAmount),
    voluntaryFrom: tax.voluntaryFrom,
    voluntaryTo: tax.voluntaryTo,
    ineMunicipalityCode: tax.ineMunicipalityCode
  };
}

// ---------------------------------------------------------------------------
// Cálculos puros
// ---------------------------------------------------------------------------

/** Etiqueta de un recibo para conceptos, calendario y mensajes: «IBI 2026», «IAE 2026 (PAC-02)». */
export function receiptLabel(kind: PropertyTaxKind | string, fiscalYear: number, period: string): string {
  const kindLabel = PROPERTY_TAX_KIND_LABELS[kind as PropertyTaxKind] ?? "Tributo";
  return `${kindLabel} ${fiscalYear}${period && period !== "anual" ? ` (${period})` : ""}`;
}

/** KPI `annualTaxBurden` (§4): Σ expectedAnnualAmount de los tributos activos cuyo contribuyente es la sociedad; null sin ninguno. */
export function computeAnnualTaxBurden(taxes: ReadonlyArray<{ status: string; taxpayer: string; expectedAnnualAmount: Decimal | string | null }>): MoneyString | null {
  let total: Decimal | null = null;
  for (const tax of taxes) {
    if (tax.status !== "activo" || tax.taxpayer !== "sociedad" || tax.expectedAnnualAmount === null) continue;
    total = (total ?? dec(0)).plus(tax.expectedAnnualAmount);
  }
  return total === null ? null : money(total);
}

export type ReceiptEntryTaxInput = { kind: PropertyTaxKind | string; taxpayer: PropertyTaxTaxpayer | string; accountCode: string; capitalizable: boolean; fiscalReference: string | null };
export type ReceiptEntryReceiptInput = {
  status: PropertyTaxReceiptStatus | string;
  fiscalYear: number;
  period: string;
  amount: Decimal | string;
  surchargeAmount: Decimal | string;
  paidAt: IsoDay | null;
  paidWith: PropertyTaxPaidWith | string | null;
  dueTo: IsoDay | null;
};

/**
 * Asiento propuesto de un recibo (§6), puro. Lanza los 409 tipados de negocio:
 * TAXPAYER_NOT_ENTITY (contribuyente distinto de la sociedad), RECEIPT_NOT_PAYABLE
 * (recibo `previsto` o sin importe). Fecha contable: paidAt ?? dueTo ?? hoy.
 */
export function buildReceiptEntryProposal(input: { tax: ReceiptEntryTaxInput; receipt: ReceiptEntryReceiptInput; propertyLabel: string; today: IsoDay }): ReceiptEntryProposal {
  const { tax, receipt } = input;
  if (tax.taxpayer !== "sociedad") {
    throw realEstateError(409, "TAXPAYER_NOT_ENTITY", "El asiento solo se propone cuando el contribuyente es la sociedad (este tributo lo paga un tercero).", { taxpayer: tax.taxpayer });
  }
  if (receipt.status === "previsto") {
    throw realEstateError(409, "RECEIPT_NOT_PAYABLE", "El recibo está previsto: regístralo como recibido o domiciliado (o pagado) antes de proponer el asiento.", { status: receipt.status });
  }
  const total = dec(receipt.amount).plus(receipt.surchargeAmount);
  if (total.lte(0)) {
    throw realEstateError(409, "RECEIPT_NOT_PAYABLE", "El recibo no tiene importe: registra el importe del recibo antes de proponer el asiento.", { status: receipt.status, amount: money(receipt.amount) });
  }
  const label = receiptLabel(tax.kind, receipt.fiscalYear, receipt.period);
  const description = `${label} · ${input.propertyLabel}${tax.fiscalReference ? ` · ${tax.fiscalReference}` : ""}`;
  const debitAccountCode = receiptDebitAccount(tax);
  const paid = isReceiptPaid(receipt);
  const creditAccountCode = paid ? RECEIPT_COUNTER_ACCOUNTS[(receipt.paidWith ?? DEFAULT_PAID_WITH) as PropertyTaxPaidWith] ?? RECEIPT_COUNTER_ACCOUNTS[DEFAULT_PAID_WITH] : TAX_LIABILITY_ACCOUNT;
  const amount = Number(total.toFixed(2));
  const surcharge = dec(receipt.surchargeAmount);
  const debitDescription = surcharge.gt(0) ? `${label} · cuota ${money(receipt.amount)} + recargo ${money(surcharge)}` : `${label} · cuota`;
  const creditDescription = paid ? `Pago ${label}${receipt.paidAt ? ` (${formatDay(receipt.paidAt)})` : ""}` : `${label} pendiente de pago`;
  return {
    entryDate: receipt.paidAt ?? receipt.dueTo ?? input.today,
    description,
    reference: tax.fiscalReference ?? undefined,
    lines: [
      { accountCode: debitAccountCode, debit: amount, credit: 0, description: debitDescription },
      { accountCode: creditAccountCode, debit: 0, credit: amount, description: creditDescription }
    ],
    total: money(total),
    debitAccountCode,
    creditAccountCode
  };
}

/**
 * Asiento de PAGO de un recibo cuyo asiento de devengo (D 631 / H 475) ya está
 * contabilizado (ACT-REV-04), puro: D 475 / H 570 · 5721 · 572 según `paidWith`
 * por cuota + recargo; fecha contable = paidAt ?? hoy.
 */
export function buildReceiptPaymentProposal(input: { tax: ReceiptEntryTaxInput; receipt: ReceiptEntryReceiptInput; propertyLabel: string; today: IsoDay }): ReceiptEntryProposal {
  const { tax, receipt } = input;
  const total = dec(receipt.amount).plus(receipt.surchargeAmount);
  if (total.lte(0)) {
    throw realEstateError(409, "RECEIPT_NOT_PAYABLE", "El recibo no tiene importe: registra el importe del recibo antes de pagarlo.", { status: receipt.status, amount: money(receipt.amount) });
  }
  const label = receiptLabel(tax.kind, receipt.fiscalYear, receipt.period);
  const creditAccountCode = RECEIPT_COUNTER_ACCOUNTS[(receipt.paidWith ?? DEFAULT_PAID_WITH) as PropertyTaxPaidWith] ?? RECEIPT_COUNTER_ACCOUNTS[DEFAULT_PAID_WITH];
  const amount = Number(total.toFixed(2));
  const paidAt = receipt.paidAt ?? input.today;
  return {
    entryDate: paidAt,
    description: `Pago ${label} · ${input.propertyLabel}${tax.fiscalReference ? ` · ${tax.fiscalReference}` : ""}`,
    reference: tax.fiscalReference ?? undefined,
    lines: [
      { accountCode: TAX_LIABILITY_ACCOUNT, debit: amount, credit: 0, description: `${label} · cancelación de la deuda con la administración` },
      { accountCode: creditAccountCode, debit: 0, credit: amount, description: `Pago ${label} (${formatDay(paidAt)})` }
    ],
    total: money(total),
    debitAccountCode: TAX_LIABILITY_ACCOUNT,
    creditAccountCode
  };
}

export type CalendarTaxInput = { tax: { id: string; kind: PropertyTaxKind | string; status: string; expected: ExpectedReceipt[] }; receipts: ReadonlyArray<{ id: string; fiscalYear: number; period: string; status: string; dueFrom: IsoDay | null; dueTo: IsoDay | null; paidAt: IsoDay | null }> };

/**
 * Calendario del ejercicio (puro, §5 «Calendario anual»): un evento por inicio
 * y fin del periodo voluntario de cada recibo del año (TAX_OVERDUE si venció
 * sin pagar) y los periodos del calendario del tributo que aún no tienen recibo.
 */
export function buildTaxCalendar(input: { year: number; today: IsoDay; propertyId: string; taxes: CalendarTaxInput[] }): PropertyTaxCalendar {
  const events: RealEstateCalendarEvent[] = [];
  const pending: PropertyTaxPendingPeriod[] = [];
  for (const { tax, receipts } of input.taxes) {
    const ofYear = receipts.filter((receipt) => receipt.fiscalYear === input.year);
    for (const receipt of ofYear) {
      const label = receiptLabel(tax.kind, receipt.fiscalYear, receipt.period);
      const base = { entityType: "property_tax_receipt" as const, entityId: receipt.id, propertyId: input.propertyId };
      if (receipt.dueFrom) events.push({ ...base, kind: "TAX_DUE", dueAt: receipt.dueFrom, label: `Inicio del periodo voluntario · ${label}` });
      if (receipt.dueTo) {
        const paid = isReceiptPaid(receipt);
        const overdue = !paid && isReceiptOverdue({ status: receipt.status, dueTo: receipt.dueTo, paidAt: receipt.paidAt }, input.today);
        events.push({ ...base, kind: overdue ? "TAX_OVERDUE" : "TAX_DUE", dueAt: receipt.dueTo, label: paid ? `Pagado${receipt.paidAt ? ` el ${formatDay(receipt.paidAt)}` : ""} · ${label}` : overdue ? `Vencido sin pagar · ${label}` : `Fin del periodo voluntario · ${label}` });
      }
    }
    if (tax.status !== "activo") continue;
    const generated = new Set(ofYear.map((receipt) => receipt.period));
    for (const expected of tax.expected) {
      if (generated.has(expected.period)) continue;
      pending.push({ taxId: tax.id, kind: tax.kind as PropertyTaxKind, period: expected.period, dueFrom: expected.dueFrom, dueTo: expected.dueTo, amount: expected.amount });
    }
  }
  events.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.entityId.localeCompare(b.entityId) || a.label.localeCompare(b.label));
  pending.sort((a, b) => a.dueTo.localeCompare(b.dueTo) || a.taxId.localeCompare(b.taxId) || a.period.localeCompare(b.period));
  return { year: input.year, events, pending };
}

// ---------------------------------------------------------------------------
// Búsquedas con tenencia (siempre a través del centro) y estados del asiento
// ---------------------------------------------------------------------------

async function requirePropertyTax(db: Db, propertyId: string, taxId: string): Promise<PropertyTax> {
  const row = await db.propertyTax.findFirst({ where: { id: taxId, propertyId, asset: { propertyId } } });
  if (!row) throw new NotFoundError("Tributo no encontrado.");
  return row;
}

async function requireReceipt(db: Db, propertyId: string, receiptId: string): Promise<{ tax: PropertyTax; receipt: PropertyTaxReceipt }> {
  const row = await db.propertyTaxReceipt.findFirst({ where: { id: receiptId, tax: { propertyId, asset: { propertyId } } }, include: { tax: true } });
  if (!row) throw new NotFoundError("Recibo no encontrado.");
  const { tax, ...receipt } = row;
  return { tax, receipt };
}

/** `JournalEntry.status` de los asientos enlazados (una consulta por lote). */
async function journalStatusesOf(db: Db, receipts: ReadonlyArray<{ journalEntryId: string | null }>): Promise<Map<string, RealEstateJournalEntryStatus>> {
  const ids = Array.from(new Set(receipts.map((receipt) => receipt.journalEntryId).filter((id): id is string => typeof id === "string" && id.length > 0)));
  if (ids.length === 0) return new Map();
  const rows = await db.journalEntry.findMany({ where: { id: { in: ids } }, select: { id: true, status: true }, take: ids.length });
  return new Map(rows.map((row) => [row.id, String(row.status) as RealEstateJournalEntryStatus]));
}

async function receiptRecordsOf(db: Db, rows: PropertyTaxReceipt[], today: IsoDay): Promise<PropertyTaxReceiptRecord[]> {
  const statuses = await journalStatusesOf(db, rows);
  return rows.map((row) => toPropertyTaxReceiptRecord(row, today, row.journalEntryId ? (statuses.get(row.journalEntryId) ?? null) : null));
}

const RECEIPT_ORDER: Prisma.PropertyTaxReceiptOrderByWithRelationInput[] = [{ fiscalYear: "desc" }, { dueTo: "asc" }, { createdAt: "asc" }];

async function taxWithReceipts(db: Db, tax: PropertyTax, today: IsoDay, where: Prisma.PropertyTaxReceiptWhereInput = {}): Promise<PropertyTaxWithReceipts> {
  const rows = await db.propertyTaxReceipt.findMany({ where: { taxId: tax.id, ...where }, orderBy: RECEIPT_ORDER });
  return { ...toPropertyTaxRecord(tax), receipts: await receiptRecordsOf(db, rows, today) };
}

function auditBase(input: RealEstateCommandInput, organizationId: string) {
  return { organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user" as const, correlationId: input.correlationId };
}

const TAX_AUDIT_FIELDS = ["kind", "taxpayer", "unitId", "fiscalReference", "taxBase", "ratePct", "expectedAnnualAmount", "periodicity", "voluntaryFrom", "voluntaryTo", "directDebit", "directDebitBonusPct", "installmentsJson", "accountCode", "capitalizable", "status"] as const satisfies ReadonlyArray<keyof PropertyTaxRecord>;

function pick<T extends object>(record: T, keys: ReadonlyArray<keyof T>): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, (record[key] as unknown) ?? null]));
}

// ---------------------------------------------------------------------------
// Tributos (GET · POST …/real-estate/taxes · PATCH …/taxes/:taxId)
// ---------------------------------------------------------------------------

export async function listPropertyTaxes(propertyId: string, query: unknown, today: IsoDay = toIsoDay(new Date())): Promise<PropertyTaxWithReceipts[]> {
  const filter = parseOr400(PropertyTaxListQuerySchema, query ?? {}, "Filtro de tributos");
  const asset = await requireRealEstateAsset(prisma, propertyId);
  const taxes = await prisma.propertyTax.findMany({
    where: { assetId: asset.id, propertyId, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }]
  });
  const receiptWhere: Prisma.PropertyTaxReceiptWhereInput = { ...(filter.year ? { fiscalYear: filter.year } : {}), ...(filter.receiptStatus ? { status: filter.receiptStatus } : {}) };
  const out: PropertyTaxWithReceipts[] = [];
  for (const tax of taxes) out.push(await taxWithReceipts(prisma, tax, today, receiptWhere));
  return out;
}

export async function createPropertyTax(input: RealEstateCommandInput & { body: unknown }): Promise<PropertyTaxWithReceipts> {
  const data = parseOr400(PropertyTaxCreateSchema, input.body ?? {}, "Tributo");
  const asset = await requireRealEstateAsset(prisma, input.propertyId);
  if (data.unitId) await requireRealEstateUnit(prisma, input.propertyId, data.unitId);
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { ineMunicipalityCode: true } });
  const capitalizable = data.capitalizable ?? data.kind === "icio";
  const row = await prisma.propertyTax.create({
    data: {
      ...definedFields(data),
      kind: data.kind,
      authorityName: data.authorityName,
      installmentsJson: installmentsJsonInput(data.installmentsJson),
      capitalizable,
      accountCode: data.accountCode ?? defaultTaxAccountCode(data.kind, capitalizable),
      organizationId: asset.organizationId,
      propertyId: input.propertyId,
      assetId: asset.id,
      ineMunicipalityCode: property?.ineMunicipalityCode ?? null,
      status: "activo"
    }
  });
  const record = toPropertyTaxRecord(row);
  recordAuditEvent({ ...auditBase(input, asset.organizationId), action: "PROPERTY_TAX_CREATED", entityType: "property_tax", entityId: row.id, afterJson: { assetId: asset.id, ...pick(record, TAX_AUDIT_FIELDS) } });
  return { ...record, receipts: [] };
}

export async function updatePropertyTax(input: RealEstateCommandInput & { taxId: string; body: unknown }): Promise<PropertyTaxWithReceipts> {
  const data = parseOr400(PropertyTaxPatchSchema, input.body ?? {}, "Tributo");
  const before = await requirePropertyTax(prisma, input.propertyId, input.taxId);
  if (data.unitId) await requireRealEstateUnit(prisma, input.propertyId, data.unitId);
  const { installmentsJson, ...rest } = data;
  const patch: Prisma.PropertyTaxUncheckedUpdateInput = definedFields(rest);
  if (installmentsJson !== undefined) patch.installmentsJson = installmentsJsonInput(installmentsJson);
  const after = await prisma.propertyTax.update({ where: { id: before.id }, data: patch });
  const beforeRecord = toPropertyTaxRecord(before);
  const afterRecord = toPropertyTaxRecord(after);
  const changed = Object.keys(patch) as Array<keyof PropertyTaxRecord>;
  recordAuditEvent({ ...auditBase(input, before.organizationId), action: "PROPERTY_TAX_UPDATED", entityType: "property_tax", entityId: before.id, beforeJson: pick(beforeRecord, changed), afterJson: pick(afterRecord, changed) });
  return taxWithReceipts(prisma, after, toIsoDay(new Date()));
}

// ---------------------------------------------------------------------------
// Recibos (POST …/taxes/:taxId/receipts · POST …/receipts/generate · GET …/receipts · PATCH …/receipts/:id)
// ---------------------------------------------------------------------------

const RECEIPT_AUDIT_FIELDS = ["fiscalYear", "period", "issuedAt", "dueFrom", "dueTo", "amount", "surchargeAmount", "status", "paidAt", "paidWith", "journalEntryId", "capexProjectId", "documentId", "appealRef"] as const satisfies ReadonlyArray<keyof PropertyTaxReceiptRecord>;

/** Recibo manual (una liquidación que no sigue el calendario, un ejercicio anterior…). */
export async function createPropertyTaxReceipt(input: RealEstateCommandInput & { taxId: string; body: unknown }): Promise<PropertyTaxReceiptRecord> {
  const data = parseOr400(PropertyTaxReceiptCreateSchema, input.body ?? {}, "Recibo");
  const tax = await requirePropertyTax(prisma, input.propertyId, input.taxId);
  const period = data.period ?? "anual";
  const duplicate = await prisma.propertyTaxReceipt.findUnique({ where: { taxId_fiscalYear_period: { taxId: tax.id, fiscalYear: data.fiscalYear, period } }, select: { id: true } });
  if (duplicate) throw realEstateError(409, "RECEIPT_ALREADY_EXISTS", `Ya existe el recibo ${period} de ${data.fiscalYear} de este tributo.`, { receiptId: duplicate.id, fiscalYear: data.fiscalYear, period });
  // Sin ventana en el cuerpo, la del calendario del tributo para ese periodo (si existe).
  let window: { dueFrom: Date | null; dueTo: Date | null } = { dueFrom: data.dueFrom ?? null, dueTo: data.dueTo ?? null };
  if (data.dueFrom === undefined && data.dueTo === undefined) {
    const expected = expectedReceiptsFor(expectedReceiptInputOf(tax), data.fiscalYear).find((item) => item.period === period);
    if (expected) window = { dueFrom: utcDay(expected.dueFrom), dueTo: utcDay(expected.dueTo) };
  }
  let row: PropertyTaxReceipt;
  try {
    row = await prisma.propertyTaxReceipt.create({ data: { ...definedFields(data), fiscalYear: data.fiscalYear, period, ...window, status: data.status ?? "previsto", taxId: tax.id } });
  } catch (error) {
    if (isUniqueViolation(error)) throw realEstateError(409, "RECEIPT_ALREADY_EXISTS", `Ya existe el recibo ${period} de ${data.fiscalYear} de este tributo.`, { fiscalYear: data.fiscalYear, period });
    throw error;
  }
  const record = toPropertyTaxReceiptRecord(row, toIsoDay(new Date()), null);
  recordAuditEvent({ ...auditBase(input, tax.organizationId), action: "PROPERTY_TAX_RECEIPT_CREATED", entityType: "property_tax_receipt", entityId: row.id, afterJson: { taxId: tax.id, kind: tax.kind, source: "manual", ...pick(record, RECEIPT_AUDIT_FIELDS) } });
  return record;
}

const GenerateReceiptsSchema = z
  .object({
    year: z.number({ invalid_type_error: "year debe ser un año (AAAA)." }).int({ message: "year debe ser un año (AAAA)." }).min(REAL_ESTATE_MIN_YEAR, { message: `year debe ser ≥ ${REAL_ESTATE_MIN_YEAR}.` }).max(REAL_ESTATE_MAX_YEAR, { message: `year debe ser ≤ ${REAL_ESTATE_MAX_YEAR}.` })
  })
  .strict();

/**
 * Crea los recibos `previsto` que falten para el ejercicio según el calendario
 * del tributo (expectedReceiptsFor): idempotente por (taxId, fiscalYear, period);
 * los recibos ya existentes (previstos, recibidos, pagados…) no se tocan.
 */
export async function generatePropertyTaxReceipts(input: RealEstateCommandInput & { taxId: string; body: unknown }): Promise<PropertyTaxReceiptsGenerated> {
  const { year } = parseOr400(GenerateReceiptsSchema, input.body ?? {}, "Generación de recibos");
  const today = toIsoDay(new Date());
  const tax = await requirePropertyTax(prisma, input.propertyId, input.taxId);
  if (tax.status !== "activo") throw new ConflictError("El tributo está de baja: no se generan recibos previstos.", { code: "PROPERTY_TAX_INACTIVE", taxId: tax.id, status: tax.status });
  const expected = expectedReceiptsFor(expectedReceiptInputOf(tax), year);
  const created: PropertyTaxReceipt[] = [];
  let existing = 0;
  await prisma.$transaction(async (tx) => {
    const present = new Set((await tx.propertyTaxReceipt.findMany({ where: { taxId: tax.id, fiscalYear: year }, select: { period: true } })).map((row) => row.period));
    for (const item of expected) {
      if (present.has(item.period)) {
        existing += 1;
        continue;
      }
      try {
        created.push(await tx.propertyTaxReceipt.create({ data: { taxId: tax.id, fiscalYear: year, period: item.period, dueFrom: utcDay(item.dueFrom), dueTo: utcDay(item.dueTo), amount: item.amount ?? "0", status: "previsto" } }));
      } catch (error) {
        // Carrera entre dos generaciones del mismo ejercicio: el periodo ya existe.
        if (isUniqueViolation(error)) existing += 1;
        else throw error;
      }
    }
  });
  const rows = await prisma.propertyTaxReceipt.findMany({ where: { taxId: tax.id, fiscalYear: year }, orderBy: RECEIPT_ORDER });
  const receipts = await receiptRecordsOf(prisma, rows, today);
  const createdIds = new Set(created.map((row) => row.id));
  if (created.length > 0) {
    recordAuditEvent({
      ...auditBase(input, tax.organizationId),
      action: "PROPERTY_TAX_RECEIPTS_GENERATED",
      entityType: "property_tax",
      entityId: tax.id,
      afterJson: { kind: tax.kind, fiscalYear: year, existing, created: receipts.filter((receipt) => createdIds.has(receipt.id)).map((receipt) => ({ id: receipt.id, period: receipt.period, dueFrom: receipt.dueFrom, dueTo: receipt.dueTo, amount: receipt.amount })) }
    });
  }
  return { year, created: receipts.filter((receipt) => createdIds.has(receipt.id)), existing, receipts };
}

/** Recibos de todos los tributos del centro en un ejercicio (por defecto el actual), con el resumen del tributo. */
export async function listPropertyTaxReceipts(propertyId: string, query: unknown, today: IsoDay = toIsoDay(new Date())): Promise<PropertyTaxReceiptListItem[]> {
  const filter = parseOr400(RealEstateYearQuerySchema, query ?? {}, "Filtro de recibos");
  const year = filter.year ?? Number(today.slice(0, 4));
  await requireRealEstateAsset(prisma, propertyId);
  const rows = await prisma.propertyTaxReceipt.findMany({ where: { fiscalYear: year, tax: { propertyId, asset: { propertyId } } }, include: { tax: true }, orderBy: [{ dueTo: "asc" }, { createdAt: "asc" }] });
  const statuses = await journalStatusesOf(prisma, rows);
  return rows.map((row) => {
    const { tax, ...receipt } = row;
    const taxRecord = toPropertyTaxRecord(tax);
    return {
      ...toPropertyTaxReceiptRecord(receipt, today, receipt.journalEntryId ? (statuses.get(receipt.journalEntryId) ?? null) : null),
      tax: { id: taxRecord.id, kind: taxRecord.kind, taxpayer: taxRecord.taxpayer, authorityName: taxRecord.authorityName, fiscalReference: taxRecord.fiscalReference, accountCode: taxRecord.accountCode, status: taxRecord.status }
    };
  });
}

const AMOUNT_FIELDS = new Set(["amount", "surchargeAmount", "paidAt", "paidWith"]);

/** Asiento enlazado a un recibo: estado y si es el propuesto por el módulo para ESTE recibo (y si su haber es la 475). */
export type LinkedReceiptEntry = { id: string; status: RealEstateJournalEntryStatus; own: boolean; liabilityCredit: boolean };

async function linkedEntryOf(db: Db, receipt: Pick<PropertyTaxReceipt, "id" | "journalEntryId">): Promise<LinkedReceiptEntry | null> {
  if (!receipt.journalEntryId) return null;
  const entry = await db.journalEntry.findUnique({ where: { id: receipt.journalEntryId }, select: { id: true, status: true, sourceType: true, sourceId: true } });
  if (!entry) return null;
  const own = entry.sourceType === RECEIPT_ENTRY_SOURCE_TYPE && entry.sourceId === receipt.id;
  const lines = own ? await db.journalLine.findMany({ where: { journalEntryId: entry.id }, select: { accountCode: true, credit: true } }) : [];
  const liabilityCredit = lines.some((line) => line.accountCode === TAX_LIABILITY_ACCOUNT && dec(line.credit).gt(0));
  return { id: entry.id, status: String(entry.status) as RealEstateJournalEntryStatus, own, liabilityCredit };
}

/** Descarta un borrador (líneas + cabecera) solo si sigue en `draft`; true si se borró. Nunca toca un asiento numerado. */
async function discardDraft(db: Db, entryId: string): Promise<boolean> {
  const row = await db.journalEntry.findUnique({ where: { id: entryId }, select: { status: true } });
  if (!row || String(row.status) !== "draft") return false;
  await db.journalLine.deleteMany({ where: { journalEntryId: entryId } });
  const removed = await db.journalEntry.deleteMany({ where: { id: entryId, status: "draft" } });
  return removed.count > 0;
}

function receiptEntryInputs(tax: PropertyTax, receipt: PropertyTaxReceipt): { tax: ReceiptEntryTaxInput; receipt: ReceiptEntryReceiptInput } {
  return {
    tax: { kind: tax.kind, taxpayer: tax.taxpayer, accountCode: tax.accountCode, capitalizable: tax.capitalizable, fiscalReference: tax.fiscalReference },
    receipt: { status: receipt.status, fiscalYear: receipt.fiscalYear, period: receipt.period, amount: receipt.amount, surchargeAmount: receipt.surchargeAmount, paidAt: isoDayOrNull(receipt.paidAt), paidWith: receipt.paidWith, dueTo: isoDayOrNull(receipt.dueTo) }
  };
}

async function propertyLabelOf(propertyId: string): Promise<string> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { code: true, name: true } });
  return property?.code ?? property?.name ?? propertyId;
}

/** Crea el borrador de `proposal` para el recibo (nunca contabiliza); el 409 FISCAL_YEAR_CLOSED del motor se propaga. */
async function createReceiptDraft(tax: PropertyTax, receipt: Pick<PropertyTaxReceipt, "id">, propertyId: string, sourceType: string, proposal: ReceiptEntryProposal): Promise<JournalEntryDraft> {
  return createJournalEntryDraft({
    organizationId: tax.organizationId,
    propertyId,
    sourceType,
    sourceId: receipt.id,
    entryDate: proposal.entryDate,
    description: proposal.description,
    reference: proposal.reference,
    lines: proposal.lines
  });
}

/**
 * PATCH de un recibo: campos, transición de estado (máquina RECEIPT) y enlace
 * manual del asiento. Pagar exige importe (409 RECEIPT_NOT_PAYABLE) y fija
 * paidAt (hoy) y paidWith (bank) si no llegan. Con asiento enlazado los
 * importes y el pago quedan congelados (409 RECEIPT_ENTRY_EXISTS): desenlaza
 * (`journalEntryId: null`) antes de corregirlos; desenlazar un borrador propio
 * lo descarta y desenlazar un asiento propio contabilizado responde 409 (anúlalo
 * antes). Al pasar a `pagado` con asiento propio enlazado: borrador → se
 * regenera con H 57x; contabilizado con H 475 → se propone el asiento de pago
 * (D 475 / H 57x) como segundo borrador (RECEIPT_PAYMENT_ENTRY_PROPOSED).
 */
export async function updatePropertyTaxReceipt(input: RealEstateCommandInput & { receiptId: string; body: unknown }): Promise<PropertyTaxReceiptRecord> {
  const data = parseOr400(PropertyTaxReceiptPatchSchema, input.body ?? {}, "Recibo");
  const { status: nextStatus, journalEntryId, ...rest } = data;
  const fields = definedFields(rest);
  const today = toIsoDay(new Date());

  // Lectura previa: el asiento que acompaña al cambio de estado se decide (y se crea) ANTES de la transacción,
  // así un 409 del motor (ejercicio cerrado) deja el recibo intacto; si la transacción falla, el borrador se descarta.
  const preview = await requireReceipt(prisma, input.propertyId, input.receiptId);
  const linked = await linkedEntryOf(prisma, preview.receipt);
  const unlinking = journalEntryId === null;
  if (unlinking && linked?.own && linked.status === "posted") {
    throw realEstateError(409, "RECEIPT_ENTRY_EXISTS", "El asiento propuesto para este recibo ya está contabilizado: anúlalo (asiento de anulación) antes de desenlazarlo.", { journalEntryId: linked.id, journalEntryStatus: linked.status });
  }
  const paying = nextStatus === "pagado" && preview.receipt.status !== "pagado" && journalEntryId === undefined;
  let replacement: JournalEntryDraft | null = null;
  let paymentDraft: JournalEntryDraft | null = null;
  if (paying && linked?.own && (linked.status === "draft" || (linked.status === "posted" && linked.liabilityCredit))) {
    assertTransition("RECEIPT", preview.receipt.status, "pagado");
    const paidPreview: PropertyTaxReceipt = { ...preview.receipt, status: "pagado", paidAt: preview.receipt.paidAt ?? utcDay(today), paidWith: preview.receipt.paidWith ?? DEFAULT_PAID_WITH };
    const inputs = receiptEntryInputs(preview.tax, paidPreview);
    const propertyLabel = await propertyLabelOf(input.propertyId);
    if (linked.status === "draft") {
      replacement = await createReceiptDraft(preview.tax, preview.receipt, input.propertyId, RECEIPT_ENTRY_SOURCE_TYPE, buildReceiptEntryProposal({ ...inputs, propertyLabel, today }));
    } else {
      paymentDraft = await createReceiptDraft(preview.tax, preview.receipt, input.propertyId, RECEIPT_PAYMENT_ENTRY_SOURCE_TYPE, buildReceiptPaymentProposal({ ...inputs, propertyLabel, today }));
    }
  }

  let result: { tax: PropertyTax; before: PropertyTaxReceipt; after: PropertyTaxReceipt; journalEntryStatus: RealEstateJournalEntryStatus | null; patchKeys: Array<keyof PropertyTaxReceiptRecord>; discardedDraftId: string | null };
  try {
    result = await prisma.$transaction(async (tx) => {
      const { tax, receipt: before } = await requireReceipt(tx, input.propertyId, input.receiptId);
      const patch: Prisma.PropertyTaxReceiptUncheckedUpdateInput = { ...fields };
      let linkedStatus: RealEstateJournalEntryStatus | null = null;
      let discardedDraftId: string | null = null;
      const ownDraftLinked = linked?.own === true && linked.status === "draft" && before.journalEntryId === linked.id;

      if (journalEntryId !== undefined) {
        if (journalEntryId === null) {
          // Desenlazar un borrador propio lo descarta: «volver a proponer» no deja borradores huérfanos.
          if (ownDraftLinked && (await discardDraft(tx, linked!.id))) discardedDraftId = linked!.id;
          patch.journalEntryId = null;
        } else {
          // Enlace manual: solo un asiento contabilizado de la misma organización y centro (opaco en otro caso).
          const entry = await tx.journalEntry.findFirst({ where: { id: journalEntryId, organizationId: tax.organizationId, propertyId: input.propertyId }, select: { id: true, status: true } });
          if (!entry || String(entry.status) !== "posted") throw new NotFoundError("Asiento no encontrado.");
          if (ownDraftLinked && entry.id !== linked!.id && (await discardDraft(tx, linked!.id))) discardedDraftId = linked!.id;
          patch.journalEntryId = entry.id;
          linkedStatus = "posted";
        }
      } else if (before.journalEntryId && Object.keys(fields).some((key) => AMOUNT_FIELDS.has(key))) {
        throw realEstateError(409, "RECEIPT_ENTRY_EXISTS", "El recibo ya tiene asiento enlazado: desenlázalo antes de cambiar importes o pago.", { journalEntryId: before.journalEntryId });
      }

      if (nextStatus !== undefined && nextStatus !== before.status) {
        assertTransition("RECEIPT", before.status, nextStatus);
        if (nextStatus === "pagado") {
          const amount = dec(fields.amount ?? before.amount).plus(fields.surchargeAmount ?? before.surchargeAmount);
          if (amount.lte(0)) throw realEstateError(409, "RECEIPT_NOT_PAYABLE", "El recibo no tiene importe: registra el importe del recibo antes de pagarlo.", { from: before.status, to: nextStatus, amount: money(amount) });
          patch.paidAt = fields.paidAt ?? before.paidAt ?? utcDay(today);
          patch.paidWith = fields.paidWith ?? before.paidWith ?? DEFAULT_PAID_WITH;
        }
        patch.status = nextStatus;
        if (replacement || paymentDraft) {
          // Carrera: el asiento enlazado cambió entre la lectura previa y la transacción.
          if (before.journalEntryId !== linked?.id) throw realEstateError(409, "RECEIPT_ENTRY_EXISTS", "El recibo ha cambiado mientras se procesaba la petición: vuelve a cargarlo.", { journalEntryId: before.journalEntryId ?? null });
        }
        if (replacement) {
          await discardDraft(tx, linked!.id);
          discardedDraftId = linked!.id;
          patch.journalEntryId = replacement.id;
          linkedStatus = "draft";
        }
      }

      const after = await tx.propertyTaxReceipt.update({ where: { id: before.id }, data: patch });
      const statuses = await journalStatusesOf(tx, [after]);
      const journalEntryStatus = after.journalEntryId ? (linkedStatus ?? statuses.get(after.journalEntryId) ?? null) : null;
      return { tax, before, after, journalEntryStatus, patchKeys: Object.keys(patch) as Array<keyof PropertyTaxReceiptRecord>, discardedDraftId };
    });
  } catch (error) {
    // La transacción no escribió nada: el borrador creado para acompañarla sobra.
    for (const draft of [replacement, paymentDraft]) if (draft) await discardDraft(prisma, draft.id);
    throw error;
  }

  const beforeRecord = toPropertyTaxReceiptRecord(result.before, today, null);
  const afterRecord = toPropertyTaxReceiptRecord(result.after, today, result.journalEntryStatus);
  const base = { ...auditBase(input, result.tax.organizationId), entityType: "property_tax_receipt", entityId: result.after.id };
  const statusChanged = result.before.status !== result.after.status;
  const linkChanged = (result.before.journalEntryId ?? null) !== (result.after.journalEntryId ?? null);
  const otherKeys = result.patchKeys.filter((key) => key !== "status" && key !== "journalEntryId" && !(statusChanged && (key === "paidAt" || key === "paidWith")));
  if (otherKeys.length > 0) {
    recordAuditEvent({ ...base, action: "PROPERTY_TAX_RECEIPT_UPDATED", beforeJson: pick(beforeRecord, otherKeys), afterJson: pick(afterRecord, otherKeys) });
  }
  if (statusChanged) {
    const keys = ["status", "amount", "surchargeAmount", "paidAt", "paidWith"] as const;
    recordAuditEvent({ ...base, action: "RECEIPT_STATUS_CHANGED", beforeJson: pick(beforeRecord, keys), afterJson: { taxId: result.tax.id, kind: result.tax.kind, fiscalYear: afterRecord.fiscalYear, period: afterRecord.period, ...pick(afterRecord, keys) } });
  }
  if (linkChanged) {
    recordAuditEvent({ ...base, action: "RECEIPT_ENTRY_LINKED", beforeJson: { journalEntryId: beforeRecord.journalEntryId }, afterJson: { journalEntryId: afterRecord.journalEntryId, journalEntryStatus: afterRecord.journalEntryStatus, source: replacement ? "regenerated" : "manual", discardedDraftId: result.discardedDraftId } });
  }
  if (paymentDraft) {
    recordAuditEvent({ ...base, action: "RECEIPT_PAYMENT_ENTRY_PROPOSED", afterJson: { taxId: result.tax.id, kind: result.tax.kind, fiscalYear: afterRecord.fiscalYear, period: afterRecord.period, status: afterRecord.status, accrualJournalEntryId: afterRecord.journalEntryId, journalEntryId: paymentDraft.id, journalEntryStatus: paymentDraft.status, entryDate: paymentDraft.entryDate, description: paymentDraft.description, lines: paymentDraft.lines } });
  }
  return afterRecord;
}

// ---------------------------------------------------------------------------
// Asiento propuesto (POST …/receipts/:receiptId/propose-entry)
// ---------------------------------------------------------------------------

/**
 * Propone el asiento del recibo en BORRADOR (createJournalEntryDraft: valida
 * cuadre y cuentas, exige centro y ejercicio abierto; el 409 FISCAL_YEAR_CLOSED
 * se propaga tal cual) y guarda `journalEntryId`. Nunca contabiliza. Además
 * del enlace del recibo, rechaza cualquier asiento no anulado del mismo recibo
 * (organización + sourceType + sourceId): un recibo nunca genera dos veces el
 * gasto (ACT-REV-03).
 */
export async function proposeReceiptEntry(input: RealEstateCommandInput & { receiptId: string }): Promise<PropertyTaxReceiptRecord> {
  const today = toIsoDay(new Date());
  const { tax, receipt } = await requireReceipt(prisma, input.propertyId, input.receiptId);
  if (receipt.journalEntryId) {
    throw realEstateError(409, "RECEIPT_ENTRY_EXISTS", "El recibo ya tiene un asiento propuesto o enlazado.", { journalEntryId: receipt.journalEntryId });
  }
  const existing = await prisma.journalEntry.findFirst({ where: { organizationId: tax.organizationId, sourceType: RECEIPT_ENTRY_SOURCE_TYPE, sourceId: receipt.id, status: { not: "reversed" } }, select: { id: true, status: true } });
  if (existing) {
    throw realEstateError(409, "RECEIPT_ENTRY_EXISTS", "Este recibo ya tiene un asiento propuesto o contabilizado en el diario: enlázalo (o anúlalo) en vez de proponer otro.", { journalEntryId: existing.id, journalEntryStatus: String(existing.status) });
  }
  const proposal = buildReceiptEntryProposal({ ...receiptEntryInputs(tax, receipt), propertyLabel: await propertyLabelOf(input.propertyId), today });
  const draft = await createReceiptDraft(tax, receipt, input.propertyId, RECEIPT_ENTRY_SOURCE_TYPE, proposal);
  const linked = await prisma.propertyTaxReceipt.updateMany({ where: { id: receipt.id, journalEntryId: null }, data: { journalEntryId: draft.id } });
  if (linked.count === 0) {
    // Carrera entre dos propuestas: la otra ganó; el borrador recién creado sobra (sin líneas ajenas, nunca numerado).
    await discardDraft(prisma, draft.id);
    const current = await prisma.propertyTaxReceipt.findUnique({ where: { id: receipt.id }, select: { journalEntryId: true } });
    throw realEstateError(409, "RECEIPT_ENTRY_EXISTS", "El recibo ya tiene un asiento propuesto o enlazado.", { journalEntryId: current?.journalEntryId ?? null });
  }
  const after = await prisma.propertyTaxReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
  recordAuditEvent({
    ...auditBase(input, tax.organizationId),
    action: "RECEIPT_ENTRY_PROPOSED",
    entityType: "property_tax_receipt",
    entityId: receipt.id,
    afterJson: { taxId: tax.id, kind: tax.kind, fiscalYear: receipt.fiscalYear, period: receipt.period, status: receipt.status, journalEntryId: draft.id, journalEntryStatus: draft.status, entryDate: proposal.entryDate, description: proposal.description, total: proposal.total, lines: proposal.lines }
  });
  return toPropertyTaxReceiptRecord(after, today, draft.status);
}

// ---------------------------------------------------------------------------
// Calendario (GET …/real-estate/tax-calendar?year=)
// ---------------------------------------------------------------------------

export async function getPropertyTaxCalendar(propertyId: string, query: unknown, today: IsoDay = toIsoDay(new Date())): Promise<PropertyTaxCalendar> {
  const filter = parseOr400(RealEstateYearQuerySchema, query ?? {}, "Filtro del calendario");
  const year = filter.year ?? Number(today.slice(0, 4));
  const asset = await requireRealEstateAsset(prisma, propertyId);
  const taxes = await prisma.propertyTax.findMany({ where: { assetId: asset.id, propertyId }, include: { receipts: { where: { fiscalYear: year }, orderBy: RECEIPT_ORDER } }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
  return buildTaxCalendar({
    year,
    today,
    propertyId,
    taxes: taxes.map((tax) => ({
      tax: { id: tax.id, kind: tax.kind, status: tax.status, expected: tax.status === "activo" ? expectedReceiptsFor(expectedReceiptInputOf(tax), year) : [] },
      receipts: tax.receipts.map((receipt) => ({ id: receipt.id, fiscalYear: receipt.fiscalYear, period: receipt.period, status: receipt.status, dueFrom: isoDayOrNull(receipt.dueFrom), dueTo: isoDayOrNull(receipt.dueTo), paidAt: isoDayOrNull(receipt.paidAt) }))
    }))
  });
}
