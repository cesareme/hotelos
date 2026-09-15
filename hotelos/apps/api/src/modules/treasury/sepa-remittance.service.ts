// SEPA remittances (Norma 19 direct debits · Norma 34 credit transfers):
// generation, PERSISTENCE and status (lote tesoreria-banca).
//
// Persistence: the schema of this tanda has no SepaRemittance model and the
// schema is not part of this lot, so remittances are stored as rows of
// `worker_job_runs` (a generic job/result table with JSON payload, result and
// status that nothing consumes in apps/api or apps/worker): jobName
// `treasury.sepa_remittance`, queueName `treasury`, status one of
// generated · sent · accepted · rejected · cancelled (never `queued`, so a
// future job runner cannot pick them up), payloadJson = the request + control
// totals, resultJson = { xml }. The store is behind `SepaRemittanceStore` so
// the integrator can move it to a dedicated table without touching callers
// (handoff: model `SepaRemittance` in the report).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { generateSepaRemittance, validateCreditorId, validateIban, type SepaRemittance } from "../banking-spain/sepa-norma19.generator.js";
import { generateSepaTransferRemittance, type SepaTransferRemittance } from "../banking-spain/sepa-norma34.generator.js";
import { dec, money, round2, sum } from "./money.js";
import { TREASURY_READ_KEYS, TREASURY_WRITE_KEYS, requireAnyPermission } from "./permissions.js";

export const SEPA_JOB_NAME = "treasury.sepa_remittance";
export const SEPA_QUEUE_NAME = "treasury";

export type SepaRemittanceKind = "norma19" | "norma34";
export type SepaRemittanceStatus = "generated" | "sent" | "accepted" | "rejected" | "cancelled";

const STATUS_TRANSITIONS: Record<SepaRemittanceStatus, SepaRemittanceStatus[]> = {
  generated: ["sent", "cancelled"],
  sent: ["accepted", "rejected", "cancelled"],
  accepted: [],
  rejected: [],
  cancelled: []
};

// ---- Schemas (zod strict) ----

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha YYYY-MM-DD");
const amount = z.union([z.number().positive(), z.string().regex(/^\d+([.,]\d{1,2})?$/)]);

export const norma19Schema = z
  .object({
    schema: z.enum(["CORE", "B2B"]),
    collectionDate: isoDate,
    sequenceType: z.enum(["FRST", "RCUR", "OOFF", "FNAL"]),
    creditor: z.object({ name: z.string().min(1).max(70), creditorId: z.string().min(8).max(35), iban: z.string().min(15).max(34), bic: z.string().min(8).max(11).optional() }).strict(),
    debtors: z
      .array(
        z
          .object({
            mandateId: z.string().min(1).max(35),
            mandateSignedAt: isoDate,
            name: z.string().min(1).max(70),
            iban: z.string().min(15).max(34),
            bic: z.string().min(8).max(11).optional(),
            amount,
            description: z.string().min(1).max(140),
            endToEndId: z.string().min(1).max(35)
          })
          .strict()
      )
      .min(1)
      .max(5000)
  })
  .strict();

export const norma34Schema = z
  .object({
    executionDate: isoDate,
    debtor: z.object({ name: z.string().min(1).max(70), taxId: z.string().min(1).max(35), iban: z.string().min(15).max(34), bic: z.string().min(8).max(11).optional() }).strict(),
    creditors: z
      .array(
        z
          .object({
            name: z.string().min(1).max(70),
            iban: z.string().min(15).max(34),
            bic: z.string().min(8).max(11).optional(),
            amount,
            description: z.string().min(1).max(140),
            endToEndId: z.string().min(1).max(35),
            category: z.enum(["SUPP", "SALA", "OTHR"]).optional()
          })
          .strict()
      )
      .min(1)
      .max(5000),
    batchBooking: z.boolean().optional()
  })
  .strict();

export const remittanceStatusSchema = z.object({ status: z.enum(["sent", "accepted", "rejected", "cancelled"]), note: z.string().max(500).optional() }).strict();

// ---- Store ----

export type SepaRemittanceRecord = {
  id: string;
  kind: SepaRemittanceKind;
  organizationId: string;
  propertyId: string;
  bankAccountId: string | null;
  messageId: string;
  status: SepaRemittanceStatus;
  totalAmount: string;
  transactions: number;
  executionDate: string;
  warnings: string[];
  history: Array<{ status: SepaRemittanceStatus; at: string; by: string | null; note: string | null }>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only on detail reads. */
  xml?: string;
};

type StoredPayload = {
  kind: SepaRemittanceKind;
  organizationId: string;
  propertyId: string;
  bankAccountId: string | null;
  messageId: string;
  totalAmount: string;
  transactions: number;
  executionDate: string;
  warnings: string[];
  history: SepaRemittanceRecord["history"];
  createdBy: string | null;
  request: unknown;
};

export type SepaRemittanceStore = {
  create(input: { payload: StoredPayload; xml: string; correlationId?: string }): Promise<SepaRemittanceRecord>;
  list(input: { organizationId: string; propertyId?: string | null; limit: number }): Promise<SepaRemittanceRecord[]>;
  get(id: string, organizationId: string, withXml: boolean): Promise<SepaRemittanceRecord | null>;
  setStatus(id: string, organizationId: string, status: SepaRemittanceStatus, entry: SepaRemittanceRecord["history"][number]): Promise<SepaRemittanceRecord>;
};

type JobRow = NonNullable<Awaited<ReturnType<typeof prisma.workerJobRun.findUnique>>>;

function rowToRecord(row: JobRow, withXml: boolean): SepaRemittanceRecord {
  const payload = row.payloadJson as unknown as StoredPayload;
  const result = (row.resultJson ?? {}) as { xml?: string };
  return {
    id: row.id,
    kind: payload.kind,
    organizationId: payload.organizationId,
    propertyId: payload.propertyId,
    bankAccountId: payload.bankAccountId ?? null,
    messageId: payload.messageId,
    status: row.status as SepaRemittanceStatus,
    totalAmount: payload.totalAmount,
    transactions: payload.transactions,
    executionDate: payload.executionDate,
    warnings: payload.warnings ?? [],
    history: payload.history ?? [],
    createdBy: payload.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(withXml ? { xml: result.xml ?? "" } : {})
  };
}

export const workerJobRunSepaStore: SepaRemittanceStore = {
  async create({ payload, xml, correlationId }) {
    const row = await prisma.workerJobRun.create({
      data: {
        jobName: SEPA_JOB_NAME,
        queueName: SEPA_QUEUE_NAME,
        payloadJson: payload as unknown as Prisma.InputJsonValue,
        resultJson: { xml } as Prisma.InputJsonValue,
        status: "generated",
        correlationId: correlationId ?? null,
        finishedAt: new Date()
      }
    });
    return rowToRecord(row, true);
  },
  async list({ organizationId, propertyId, limit }) {
    const rows = await prisma.workerJobRun.findMany({
      where: {
        jobName: SEPA_JOB_NAME,
        payloadJson: { path: ["organizationId"], equals: organizationId },
        ...(propertyId ? { AND: [{ payloadJson: { path: ["propertyId"], equals: propertyId } }] } : {})
      },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.map((r) => rowToRecord(r, false));
  },
  async get(id, organizationId, withXml) {
    const row = await prisma.workerJobRun.findUnique({ where: { id } });
    if (!row || row.jobName !== SEPA_JOB_NAME) return null;
    const record = rowToRecord(row, withXml);
    return record.organizationId === organizationId ? record : null;
  },
  async setStatus(id, organizationId, status, entry) {
    const row = await prisma.workerJobRun.findUnique({ where: { id } });
    if (!row || row.jobName !== SEPA_JOB_NAME) throw new NotFoundError("La remesa no existe.");
    const payload = row.payloadJson as unknown as StoredPayload;
    if (payload.organizationId !== organizationId) throw new NotFoundError("La remesa no existe.");
    const updated = await prisma.workerJobRun.update({
      where: { id },
      data: { status, payloadJson: { ...payload, history: [...(payload.history ?? []), entry] } as unknown as Prisma.InputJsonValue }
    });
    return rowToRecord(updated, false);
  }
};

let store: SepaRemittanceStore = workerJobRunSepaStore;

export function setSepaRemittanceStore(next: SepaRemittanceStore | null): void {
  store = next ?? workerJobRunSepaStore;
}

// ---- Service ----

export type CreateRemittanceInput = {
  context: UserContext;
  propertyId: string;
  kind: SepaRemittanceKind;
  body: unknown;
  bankAccountId?: string | null;
  correlationId?: string;
};

export type CreateRemittanceResult = SepaRemittanceRecord & { xml: string; totalAmount: string; warnings: string[] };

export async function createRemittance(input: CreateRemittanceInput): Promise<CreateRemittanceResult> {
  requireAnyPermission(input.context, TREASURY_WRITE_KEYS);
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("La propiedad no existe.");
  if (property.organizationId !== input.context.organizationId && !input.context.isPlatformAdmin) throw new NotFoundError("La propiedad no existe.");
  const warnings: string[] = [];
  let bankAccountId: string | null = input.bankAccountId ?? null;

  let generated: { messageId: string; xml: string; control: { totalAmount: number; transactions: number } };
  let executionDate: string;
  if (input.kind === "norma19") {
    const request = parseOr400(norma19Schema, input.body, "remesa Norma 19") as SepaRemittance;
    if (!validateIban(request.creditor.iban)) throw new BadRequestError("IBAN del acreedor no válido.");
    if (!validateCreditorId(request.creditor.creditorId)) warnings.push("El identificador de acreedor SEPA no supera el control mod-97: revísalo con el banco.");
    for (const d of request.debtors) {
      if (!validateIban(d.iban)) throw new BadRequestError(`IBAN no válido para el deudor «${d.name}».`);
      if (round2(dec(d.amount)).lte(0)) throw new BadRequestError(`Importe no positivo para el deudor «${d.name}».`);
      if (d.mandateSignedAt > request.collectionDate) warnings.push(`El mandato de «${d.name}» está firmado después de la fecha de cargo.`);
    }
    bankAccountId = bankAccountId ?? (await resolveBankAccountByIban(input.propertyId, request.creditor.iban));
    generated = generateSepaRemittance(request);
    executionDate = request.collectionDate;
  } else {
    const request = parseOr400(norma34Schema, input.body, "remesa Norma 34") as SepaTransferRemittance;
    if (!validateIban(request.debtor.iban)) throw new BadRequestError("IBAN del ordenante no válido.");
    for (const c of request.creditors) {
      if (!validateIban(c.iban)) throw new BadRequestError(`IBAN no válido para el beneficiario «${c.name}».`);
      if (round2(dec(c.amount)).lte(0)) throw new BadRequestError(`Importe no positivo para el beneficiario «${c.name}».`);
    }
    bankAccountId = bankAccountId ?? (await resolveBankAccountByIban(input.propertyId, request.debtor.iban));
    generated = generateSepaTransferRemittance(request);
    executionDate = request.executionDate;
  }
  if (!bankAccountId) warnings.push("El IBAN de la remesa no corresponde a ninguna cuenta bancaria registrada de la propiedad.");

  const now = new Date().toISOString();
  const record = await store.create({
    payload: {
      kind: input.kind,
      organizationId: property.organizationId,
      propertyId: input.propertyId,
      bankAccountId,
      messageId: generated.messageId,
      totalAmount: money(generated.control.totalAmount),
      transactions: generated.control.transactions,
      executionDate,
      warnings,
      history: [{ status: "generated", at: now, by: input.context.userId, note: null }],
      createdBy: input.context.userId,
      request: input.body
    },
    xml: generated.xml,
    correlationId: input.correlationId
  });
  return { ...record, xml: generated.xml, totalAmount: money(generated.control.totalAmount), warnings };
}

async function resolveBankAccountByIban(propertyId: string, iban: string): Promise<string | null> {
  const normalised = iban.replace(/\s+/g, "").toUpperCase();
  const accounts = await prisma.bankAccount.findMany({ where: { propertyId, active: true }, select: { id: true, iban: true } });
  return accounts.find((a) => (a.iban ?? "").replace(/\s+/g, "").toUpperCase() === normalised)?.id ?? null;
}

export async function listRemittances(input: { context: UserContext; propertyId?: string | null; limit?: number }): Promise<SepaRemittanceRecord[]> {
  requireAnyPermission(input.context, TREASURY_READ_KEYS);
  return store.list({ organizationId: input.context.organizationId, propertyId: input.propertyId ?? null, limit: Math.min(Math.max(input.limit ?? 50, 1), 500) });
}

export async function getRemittance(input: { context: UserContext; id: string }): Promise<SepaRemittanceRecord> {
  requireAnyPermission(input.context, TREASURY_READ_KEYS);
  const record = await store.get(input.id, input.context.organizationId, true);
  if (!record) throw new NotFoundError("La remesa no existe.");
  return record;
}

export async function updateRemittanceStatus(input: { context: UserContext; id: string; body: unknown }): Promise<SepaRemittanceRecord> {
  requireAnyPermission(input.context, TREASURY_WRITE_KEYS);
  const { status, note } = parseOr400(remittanceStatusSchema, input.body, "estado de la remesa");
  const current = await store.get(input.id, input.context.organizationId, false);
  if (!current) throw new NotFoundError("La remesa no existe.");
  if (!STATUS_TRANSITIONS[current.status].includes(status)) {
    throw new ConflictError(`Una remesa «${current.status}» no puede pasar a «${status}».`, { code: "REMITTANCE_STATUS_TRANSITION", from: current.status, to: status });
  }
  return store.setStatus(input.id, input.context.organizationId, status, { status, at: new Date().toISOString(), by: input.context.userId, note: note ?? null });
}

/**
 * Builds a Norma 34 body from posted, unpaid supplier bills whose supplier has
 * an IBAN (the payer bank account gives the debtor side). Bills without a
 * supplier IBAN are reported, never silently dropped.
 */
export async function buildSupplierPaymentRemittance(input: { context: UserContext; propertyId: string; bankAccountId: string; billIds: string[]; executionDate: string }): Promise<{ body: SepaTransferRemittance; skipped: Array<{ billId: string; reason: string }>; totalAmount: string }> {
  requireAnyPermission(input.context, TREASURY_WRITE_KEYS);
  const account = await prisma.bankAccount.findFirst({ where: { id: input.bankAccountId, propertyId: input.propertyId } });
  if (!account) throw new NotFoundError("La cuenta bancaria no existe en esta propiedad.");
  if (!account.iban) throw new ConflictError("La cuenta bancaria ordenante no tiene IBAN.", { code: "BANK_ACCOUNT_WITHOUT_IBAN" });
  const organization = await prisma.organization.findUnique({ where: { id: account.organizationId }, select: { legalName: true, name: true, taxId: true } });
  if (!organization?.taxId) throw new ConflictError("La organización no tiene NIF configurado.", { code: "ORGANIZATION_WITHOUT_TAX_ID" });
  const bills = await prisma.supplierBill.findMany({ where: { id: { in: input.billIds }, OR: [{ propertyId: input.propertyId }, { organizationId: account.organizationId }] } });
  const supplierIds = Array.from(new Set(bills.map((b) => b.supplierId).filter((id): id is string => Boolean(id))));
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, iban: true } }) : [];
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const skipped: Array<{ billId: string; reason: string }> = [];
  const creditors: SepaTransferRemittance["creditors"] = [];
  for (const id of input.billIds) {
    const bill = bills.find((b) => b.id === id);
    if (!bill) {
      skipped.push({ billId: id, reason: "no existe en esta organización" });
      continue;
    }
    if (bill.status !== "posted") {
      skipped.push({ billId: id, reason: `estado ${bill.status}: solo se pagan facturas contabilizadas` });
      continue;
    }
    if (bill.paymentDate) {
      skipped.push({ billId: id, reason: "ya pagada" });
      continue;
    }
    const supplier = bill.supplierId ? supplierById.get(bill.supplierId) : undefined;
    if (!supplier?.iban || !validateIban(supplier.iban)) {
      skipped.push({ billId: id, reason: "el proveedor no tiene IBAN válido" });
      continue;
    }
    creditors.push({ name: supplier.name, iban: supplier.iban, amount: money(bill.total), description: `Factura ${bill.invoiceNumber ?? bill.id}`, endToEndId: `SB-${bill.id}`.slice(0, 35), category: "SUPP" });
  }
  if (creditors.length === 0) throw new ConflictError("Ninguna factura seleccionada se puede pagar por remesa.", { code: "REMITTANCE_EMPTY", skipped });
  const body: SepaTransferRemittance = {
    executionDate: input.executionDate,
    debtor: { name: organization.legalName ?? organization.name, taxId: organization.taxId, iban: account.iban, ...(account.bic ? { bic: account.bic } : {}) },
    creditors
  };
  return { body, skipped, totalAmount: money(sum(creditors.map((c) => dec(c.amount)))) };
}
