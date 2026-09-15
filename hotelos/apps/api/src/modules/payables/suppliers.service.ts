// Payables · suppliers (Finanzas 2026-09-15, lote proveedores-activos).
//
// `Supplier` is unique per organisation (schema: suppliers.organization_id).
// The procurement dashboard (/procurement/suppliers) still reads the in-memory
// advanced records; this service is the Prisma-backed master the accounting
// documents point at (SupplierBill.supplierId). Rules:
//   · Spanish suppliers (countryCode ES) need a NIF/NIE/CIF with a correct
//     control character (`nifValidatedAt` records the check); a foreign
//     supplier keeps its VAT number normalised without the Spanish check.
//   · one NIF per organisation (409 SUPPLIER_NIF_DUPLICATE);
//   · IBAN validated (structure, national length, mod-97);
//   · defaultExpenseAccountCode must be a postable 6xx / 20x / 21x of the
//     organisation's chart; retentionRate (IRPF) with its 111/115 row code.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { dec, percentInput, type Decimal } from "./money.js";
import { checkIban, checkSpanishNif, formatIban, normalizeNif } from "./validators.js";

export type Tx = Prisma.TransactionClient | typeof prisma;

export const RETENTION_ROW_CODES = ["02", "03", "L01"] as const;
export type RetentionRowCode = (typeof RETENTION_ROW_CODES)[number];

export type SupplierDto = {
  id: string;
  organizationId: string;
  name: string;
  taxId: string | null;
  nifValidatedAt: string | null;
  isCompany: boolean | null;
  contact: { contactName?: string; email?: string; phone?: string };
  paymentTermDays: number | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  countryCode: string;
  iban: string | null;
  ibanFormatted: string | null;
  defaultExpenseAccountCode: string | null;
  retentionRate: string | null;
  retentionRowCode: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

const contactSchema = z
  .object({
    contactName: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(200).optional(),
    phone: z.string().trim().min(3).max(40).optional()
  })
  .strict();

const supplierBaseSchema = z
  .object({
    name: z.string().trim().min(1, "obligatorio").max(200),
    taxId: z.string().trim().max(20).nullable().optional(),
    countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "código de país ISO de 2 letras").optional(),
    contact: contactSchema.optional(),
    paymentTermDays: z.number().int().min(0).max(365).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    postalCode: z.string().trim().max(12).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    province: z.string().trim().max(120).nullable().optional(),
    iban: z.string().trim().max(40).nullable().optional(),
    defaultExpenseAccountCode: z.string().trim().max(12).nullable().optional(),
    retentionRate: percentInput().nullable().optional(),
    retentionRowCode: z.enum(RETENTION_ROW_CODES).nullable().optional(),
    active: z.boolean().optional()
  })
  .strict();

export const createSupplierSchema = supplierBaseSchema;
export const updateSupplierSchema = supplierBaseSchema.partial().strict();

export type CreateSupplierInput = z.input<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>;

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

type SupplierRow = NonNullable<Awaited<ReturnType<typeof prisma.supplier.findUnique>>>;

function toDto(row: SupplierRow): SupplierDto {
  const contact = (row.contactJson && typeof row.contactJson === "object" ? row.contactJson : {}) as SupplierDto["contact"];
  const terms = (row.paymentTermsJson && typeof row.paymentTermsJson === "object" ? row.paymentTermsJson : {}) as { days?: number };
  const nif = row.taxId ? checkSpanishNif(row.taxId) : null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    taxId: row.taxId ?? null,
    nifValidatedAt: row.nifValidatedAt ? row.nifValidatedAt.toISOString() : null,
    isCompany: nif && nif.ok ? nif.isCompany : null,
    contact,
    paymentTermDays: typeof terms.days === "number" ? terms.days : null,
    address: row.address ?? null,
    postalCode: row.postalCode ?? null,
    city: row.city ?? null,
    province: row.province ?? null,
    countryCode: row.countryCode,
    iban: row.iban ?? null,
    ibanFormatted: row.iban ? formatIban(row.iban) : null,
    defaultExpenseAccountCode: row.defaultExpenseAccountCode ?? null,
    retentionRate: row.retentionRate === null || row.retentionRate === undefined ? null : dec(row.retentionRate).toFixed(2),
    retentionRowCode: row.retentionRowCode ?? null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** NIF normalised + validated for the supplier's country; throws 400 SUPPLIER_NIF_INVALID for a Spanish supplier with a wrong control character. */
export function resolveSupplierTaxId(raw: string | null | undefined, countryCode: string): { taxId: string | null; nifValidatedAt: Date | null } {
  const normalized = normalizeNif(raw);
  if (!normalized) return { taxId: null, nifValidatedAt: null };
  if (countryCode !== "ES") return { taxId: normalized, nifValidatedAt: null };
  const check = checkSpanishNif(normalized);
  if (!check.ok) throw typed(400, "SUPPLIER_NIF_INVALID", `NIF del proveedor no válido: ${check.message}`, { taxId: normalized });
  return { taxId: check.value, nifValidatedAt: new Date() };
}

/** Default 111/115 row for a retention rate when the caller gives none: 19 % → alquileres (115, L01); anything else → profesionales (02). */
export function defaultRetentionRowCode(rate: Decimal | null): RetentionRowCode | null {
  if (!rate || rate.isZero()) return null;
  return rate.equals(dec(19)) ? "L01" : "02";
}

async function assertExpenseAccount(tx: Tx, organizationId: string, code: string | null | undefined): Promise<string | null> {
  if (!code) return null;
  const account = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code } }, select: { code: true, isPostable: true, group: true } });
  if (!account) throw typed(400, "EXPENSE_ACCOUNT_INVALID", `La cuenta ${code} no existe en el plan de la organización.`, { accountCode: code });
  if (!account.isPostable) throw typed(400, "EXPENSE_ACCOUNT_INVALID", `La cuenta ${code} es una cabecera y no admite apuntes.`, { accountCode: code });
  if (account.group !== 6 && account.group !== 2) {
    throw typed(400, "EXPENSE_ACCOUNT_INVALID", `La cuenta por defecto de un proveedor debe ser de gasto (6xx) o de inmovilizado (20x/21x): ${code}.`, { accountCode: code });
  }
  return account.code;
}

async function assertNifUnique(tx: Tx, organizationId: string, taxId: string | null, exceptId?: string): Promise<void> {
  if (!taxId) return;
  const existing = await tx.supplier.findFirst({ where: { organizationId, taxId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, name: true } });
  if (existing) {
    throw typed(409, "SUPPLIER_NIF_DUPLICATE", `Ya existe un proveedor con el NIF ${taxId} («${existing.name}»).`, { supplierId: existing.id, taxId });
  }
}

function resolveIban(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  const check = checkIban(raw);
  if (!check.ok) throw typed(400, "SUPPLIER_IBAN_INVALID", `IBAN no válido: ${check.message}`, { iban: check.value });
  return check.value;
}

export async function listSuppliers(input: { organizationId: string; q?: string; active?: boolean | null; limit?: number }): Promise<SupplierDto[]> {
  const q = input.q?.trim();
  const rows = await prisma.supplier.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.active === null || input.active === undefined ? {} : { active: input.active }),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { taxId: { contains: normalizeNif(q) ?? q } }] } : {})
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    take: Math.min(Math.max(input.limit ?? 200, 1), 500)
  });
  return rows.map(toDto);
}

export async function getSupplier(organizationId: string, supplierId: string): Promise<SupplierDto> {
  const row = await prisma.supplier.findFirst({ where: { id: supplierId, organizationId } });
  if (!row) throw new NotFoundError("Proveedor no encontrado.");
  return toDto(row);
}

/** The supplier row a document may reference (same organisation, any status); 404 otherwise. */
export async function requireSupplier(tx: Tx, organizationId: string, supplierId: string): Promise<SupplierRow> {
  const row = await tx.supplier.findFirst({ where: { id: supplierId, organizationId } });
  if (!row) throw new NotFoundError("Proveedor no encontrado.");
  return row;
}

export async function createSupplier(input: { context: UserContext; organizationId: string; body: unknown; correlationId: string }): Promise<SupplierDto> {
  const data = parseOr400(createSupplierSchema, input.body ?? {}, "Proveedor");
  const countryCode = data.countryCode ?? "ES";
  const { taxId, nifValidatedAt } = resolveSupplierTaxId(data.taxId, countryCode);
  const iban = resolveIban(data.iban);
  const retentionRate = data.retentionRate ?? null;
  const retentionRowCode = retentionRate && !retentionRate.isZero() ? (data.retentionRowCode ?? defaultRetentionRowCode(retentionRate)) : null;

  const row = await prisma.$transaction(async (tx) => {
    await assertNifUnique(tx, input.organizationId, taxId);
    const defaultExpenseAccountCode = await assertExpenseAccount(tx, input.organizationId, data.defaultExpenseAccountCode);
    return tx.supplier.create({
      data: {
        organizationId: input.organizationId,
        name: data.name,
        taxId,
        nifValidatedAt,
        contactJson: data.contact ?? {},
        paymentTermsJson: data.paymentTermDays === null || data.paymentTermDays === undefined ? {} : { days: data.paymentTermDays },
        address: data.address ?? null,
        postalCode: data.postalCode ?? null,
        city: data.city ?? null,
        province: data.province ?? null,
        countryCode,
        iban,
        defaultExpenseAccountCode,
        retentionRate: retentionRate && !retentionRate.isZero() ? retentionRate : null,
        retentionRowCode,
        active: data.active ?? true
      }
    });
  });
  const dto = toDto(row);
  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_CREATED",
    entityType: "supplier",
    entityId: dto.id,
    afterJson: { name: dto.name, taxId: dto.taxId, countryCode: dto.countryCode, retentionRate: dto.retentionRate },
    correlationId: input.correlationId
  });
  return dto;
}

export async function updateSupplier(input: { context: UserContext; organizationId: string; supplierId: string; body: unknown; correlationId: string }): Promise<SupplierDto> {
  const data = parseOr400(updateSupplierSchema, input.body ?? {}, "Proveedor");
  const before = await prisma.supplier.findFirst({ where: { id: input.supplierId, organizationId: input.organizationId } });
  if (!before) throw new NotFoundError("Proveedor no encontrado.");
  const countryCode = data.countryCode ?? before.countryCode;
  const patch: Prisma.SupplierUpdateInput = {};

  if (data.name !== undefined) patch.name = data.name;
  if (data.countryCode !== undefined) patch.countryCode = countryCode;
  if (data.taxId !== undefined || data.countryCode !== undefined) {
    const resolved = resolveSupplierTaxId(data.taxId !== undefined ? data.taxId : before.taxId, countryCode);
    patch.taxId = resolved.taxId;
    patch.nifValidatedAt = resolved.nifValidatedAt;
  }
  if (data.contact !== undefined) patch.contactJson = data.contact;
  if (data.paymentTermDays !== undefined) patch.paymentTermsJson = data.paymentTermDays === null ? {} : { days: data.paymentTermDays };
  if (data.address !== undefined) patch.address = data.address;
  if (data.postalCode !== undefined) patch.postalCode = data.postalCode;
  if (data.city !== undefined) patch.city = data.city;
  if (data.province !== undefined) patch.province = data.province;
  if (data.iban !== undefined) patch.iban = resolveIban(data.iban);
  if (data.retentionRate !== undefined || data.retentionRowCode !== undefined) {
    const rate = data.retentionRate !== undefined ? data.retentionRate : before.retentionRate === null ? null : dec(before.retentionRate);
    const effective = rate && !rate.isZero() ? rate : null;
    patch.retentionRate = effective;
    patch.retentionRowCode = effective ? (data.retentionRowCode ?? before.retentionRowCode ?? defaultRetentionRowCode(effective)) : null;
  }
  if (data.active !== undefined) patch.active = data.active;

  const row = await prisma.$transaction(async (tx) => {
    if (patch.taxId !== undefined) await assertNifUnique(tx, input.organizationId, (patch.taxId as string | null) ?? null, before.id);
    if (data.defaultExpenseAccountCode !== undefined) {
      patch.defaultExpenseAccountCode = await assertExpenseAccount(tx, input.organizationId, data.defaultExpenseAccountCode);
    }
    return tx.supplier.update({ where: { id: before.id }, data: patch });
  });
  const dto = toDto(row);
  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_UPDATED",
    entityType: "supplier",
    entityId: dto.id,
    beforeJson: { name: before.name, taxId: before.taxId, active: before.active, iban: before.iban ? formatIban(before.iban) : null },
    afterJson: { name: dto.name, taxId: dto.taxId, active: dto.active, iban: dto.ibanFormatted },
    correlationId: input.correlationId
  });
  return dto;
}
