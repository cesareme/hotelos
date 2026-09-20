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
// totals (+ `billIds` and `sod` when built by `buildSupplierPaymentRemittance`,
// corrector CIERRE-1 · REV-01), resultJson = { xml }. The store is behind `SepaRemittanceStore` so
// the integrator can move it to a dedicated table without touching callers
// (handoff: model `SepaRemittance` in the report).
//
// Identity (Tanda 6b · L4, design §5.2 R1/R2): the ordenante of a Norma 34
// (and the sociedad behind a Norma 19 creditor) is the LEGAL ENTITY —
// `requireLegalIdentity` (lib/finance-scope.ts), never `Organization.taxId`;
// 409 ISSUER_TAX_ID_MISSING when the sociedad has no valid NIF. The payer bank
// account may belong to the centre or to the sociedad (no centre:
// `bankAccountServesCentre`), and every stored remittance carries the
// `legalEntityId` it was generated for.
//
// Audit (corrector CIERRE-1 · REV-01): every remittance persisted by
// `createRemittance` — Norma 19 or 34, from `POST /treasury/sepa/remittances`
// or from `POST /treasury/sepa/supplier-payments` with `generate` — records
// `SEPA_REMITTANCE_GENERATED` (entity `worker_job_run`) with the control data
// and, for supplier remittances, the bills paid and the SoD outcome of each
// (`privileged` / controller exception / unknown author visible in the review);
// never the XML, the IBANs, the names nor the warnings.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { requireLegalIdentity } from "../../lib/finance-scope.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { assertSupplierBillPaymentAuthorized } from "../payables/supplier-bills.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { generateSepaRemittance, validateCreditorId, validateIban, type SepaRemittance } from "../banking-spain/sepa-norma19.generator.js";
import { generateSepaTransferRemittance, type SepaTransferRemittance } from "../banking-spain/sepa-norma34.generator.js";
import { dec, money, round2, sum } from "./money.js";
import { REMITTANCE_WRITE_KEYS, TREASURY_READ_KEYS, requireAnyPermission, type SodCheckOutcome } from "./permissions.js";
import { bankAccountServesCentre } from "./treasury.service.js";

export const SEPA_JOB_NAME = "treasury.sepa_remittance";
export const SEPA_QUEUE_NAME = "treasury";
/** Corrector CIERRE-1 (REV-01): audit action of every persisted remittance (`docs/runbooks/auditoria-eventos.md` §6.3). */
export const SEPA_REMITTANCE_GENERATED_ACTION = "SEPA_REMITTANCE_GENERATED";
/**
 * Corrector CIERRE-1 (REV-02 / FUN-02): `details.code` of the 403 a Norma 34 gets
 * when its body was NOT built by `buildSupplierPaymentRemittance` — a transfer
 * file is a payment and only leaves through `POST /treasury/sepa/supplier-payments`
 * (`payables.pay` + per-bill SoD gate); the generic route keeps the Norma 19.
 */
export const SUPPLIER_PAYMENT_ROUTE_REQUIRED_CODE = "SUPPLIER_PAYMENT_ROUTE_REQUIRED";
export const SUPPLIER_PAYMENT_ROUTE_REQUIRED_MESSAGE = "Las remesas Norma 34 (transferencias) solo se generan desde POST /treasury/sepa/supplier-payments, que aplica la separación de funciones por factura (payables.pay); la remesa genérica admite adeudos Norma 19.";

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
  /** Sociedad the remittance was generated for (null on rows stored before Tanda 6b). */
  legalEntityId: string | null;
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
  /** Only on remittances built by `buildSupplierPaymentRemittance`: the bills paid and the SoD outcome of each (corrector CIERRE-1 · FUN-07: `banking.read` sees them on the list and the detail, not only `audit.read`). */
  billIds?: string[];
  sod?: SupplierPaymentSod[];
};

/** Outcome of the payment gate for ONE bill of a supplier remittance (corrector CIERRE-1 · REV-01): what `POST …/supplier-bills/:id/pay` audits, per bill. */
export type SupplierPaymentSod = { billId: string; creator: SodCheckOutcome; approver: SodCheckOutcome | null; controllerException: boolean };

type SupplierPaymentProvenance = { billIds: string[]; sod: SupplierPaymentSod[] };

/**
 * Provenance of the bodies built by `buildSupplierPaymentRemittance`, keyed by
 * the body object itself (corrector CIERRE-1 · REV-01): the route hands that
 * SAME object to `createRemittance` (`POST /treasury/sepa/supplier-payments`
 * with `generate: true`), which persists `billIds` + `sod` in the payload and
 * audits them without the route threading them through. A cloned or hand-made
 * body carries no provenance: since the corrector CIERRE-1 (REV-02 / FUN-02) a
 * Norma 34 without it is REFUSED (403 `SUPPLIER_PAYMENT_ROUTE_REQUIRED`, nothing
 * parsed nor persisted) — the rbac-sod suite pins the HTTP path both ways.
 */
const supplierPaymentProvenance = new WeakMap<object, SupplierPaymentProvenance>();

type StoredPayload = {
  kind: SepaRemittanceKind;
  organizationId: string;
  legalEntityId?: string | null;
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
  /** Only on remittances built by `buildSupplierPaymentRemittance`: bills paid and the SoD outcome of each (corrector CIERRE-1 · REV-01). */
  billIds?: string[];
  sod?: SupplierPaymentSod[];
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
    // Tanda L2 (L2-04): las columnas organization_id / property_id (L2-01) son
    // la fuente del ámbito; payloadJson conserva las mismas claves por
    // compatibilidad con las filas anteriores y con los consumidores del JSON.
    organizationId: row.organizationId ?? payload.organizationId,
    legalEntityId: payload.legalEntityId ?? null,
    propertyId: row.propertyId ?? payload.propertyId,
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
    ...(withXml ? { xml: result.xml ?? "" } : {}),
    // Corrector CIERRE-1 (FUN-07): the provenance persisted by REV-01 reaches the DTO (list and detail).
    ...(payload.billIds ? { billIds: payload.billIds, sod: payload.sod ?? [] } : {})
  };
}

export const workerJobRunSepaStore: SepaRemittanceStore = {
  async create({ payload, xml, correlationId }) {
    const row = await prisma.workerJobRun.create({
      data: {
        organizationId: payload.organizationId,
        propertyId: payload.propertyId,
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
    // Fail-secure: solo las filas cuya columna organization_id coincide (una
    // remesa anterior a L2-01 sin columna no aparece hasta que se rellene).
    const rows = await prisma.workerJobRun.findMany({
      where: {
        jobName: SEPA_JOB_NAME,
        organizationId,
        ...(propertyId ? { propertyId } : {})
      },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.map((r) => rowToRecord(r, false));
  },
  async get(id, organizationId, withXml) {
    const row = await prisma.workerJobRun.findFirst({ where: { id, jobName: SEPA_JOB_NAME, organizationId } });
    return row ? rowToRecord(row, withXml) : null;
  },
  async setStatus(id, organizationId, status, entry) {
    const row = await prisma.workerJobRun.findFirst({ where: { id, jobName: SEPA_JOB_NAME, organizationId } });
    if (!row) throw new NotFoundError("La remesa no existe.");
    const payload = row.payloadJson as unknown as StoredPayload;
    const updated = await prisma.workerJobRun.update({
      where: { id: row.id },
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
  requireAnyPermission(input.context, REMITTANCE_WRITE_KEYS);
  // Corrector CIERRE-1 (REV-01): a body built by buildSupplierPaymentRemittance carries the bills paid and their SoD outcomes.
  const provenance = input.kind === "norma34" && typeof input.body === "object" && input.body !== null ? supplierPaymentProvenance.get(input.body) : undefined;
  // Corrector CIERRE-1 (REV-02 / FUN-02): a Norma 34 is a payment order. Without
  // provenance (hand-made body through POST /treasury/sepa/remittances under
  // banking.reconcile, or a clone) it would pay the caller's own bills without
  // payables.pay nor the per-bill SoD gate of T9 17d → 403, before parsing the
  // body and before touching the store (fail-closed, nothing persisted).
  if (input.kind === "norma34" && !provenance) {
    throw new ForbiddenError(SUPPLIER_PAYMENT_ROUTE_REQUIRED_MESSAGE, { code: SUPPLIER_PAYMENT_ROUTE_REQUIRED_CODE, route: "POST /treasury/sepa/supplier-payments", requiredPermission: "payables.pay" });
  }
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("La propiedad no existe.");
  if (property.organizationId !== input.context.organizationId && !input.context.isPlatformAdmin) throw new NotFoundError("La propiedad no existe.");
  const identity = await requireLegalIdentity(property.organizationId);
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
    bankAccountId = bankAccountId ?? (await resolveBankAccountByIban(property.organizationId, input.propertyId, request.creditor.iban));
    generated = generateSepaRemittance(request);
    executionDate = request.collectionDate;
  } else {
    const request = parseOr400(norma34Schema, input.body, "remesa Norma 34") as SepaTransferRemittance;
    if (!validateIban(request.debtor.iban)) throw new BadRequestError("IBAN del ordenante no válido.");
    for (const c of request.creditors) {
      if (!validateIban(c.iban)) throw new BadRequestError(`IBAN no válido para el beneficiario «${c.name}».`);
      if (round2(dec(c.amount)).lte(0)) throw new BadRequestError(`Importe no positivo para el beneficiario «${c.name}».`);
    }
    bankAccountId = bankAccountId ?? (await resolveBankAccountByIban(property.organizationId, input.propertyId, request.debtor.iban));
    generated = generateSepaTransferRemittance(request);
    executionDate = request.executionDate;
  }
  if (!bankAccountId) warnings.push("El IBAN de la remesa no corresponde a ninguna cuenta bancaria registrada de la propiedad ni de la sociedad.");

  const now = new Date().toISOString();
  const totalAmount = money(generated.control.totalAmount);
  const record = await store.create({
    payload: {
      kind: input.kind,
      organizationId: property.organizationId,
      legalEntityId: identity.legalEntityId,
      propertyId: input.propertyId,
      bankAccountId,
      messageId: generated.messageId,
      totalAmount,
      transactions: generated.control.transactions,
      executionDate,
      warnings,
      history: [{ status: "generated", at: now, by: input.context.userId, note: null }],
      createdBy: input.context.userId,
      request: input.body,
      ...(provenance ? { billIds: provenance.billIds, sod: provenance.sod } : {})
    },
    xml: generated.xml,
    correlationId: input.correlationId
  });
  // Corrector CIERRE-1 (REV-01): generating a bank file is audited — control
  // data and, for a supplier remittance, the bills and the SoD outcome of each
  // (`privileged` / controller exception / unknown author must reach the
  // review). Never the XML, IBANs, names nor warnings (they may quote a name).
  recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: SEPA_REMITTANCE_GENERATED_ACTION,
    entityType: "worker_job_run",
    entityId: record.id,
    afterJson: {
      kind: input.kind,
      status: "generated",
      messageId: generated.messageId,
      legalEntityId: identity.legalEntityId,
      bankAccountId,
      totalAmount,
      transactions: generated.control.transactions,
      executionDate,
      billIds: provenance?.billIds ?? null,
      sod: provenance?.sod ?? null
    },
    correlationId: input.correlationId
  });
  return { ...record, xml: generated.xml, totalAmount, warnings };
}

/** Active account of the centre — or of the sociedad (no centre) — with that IBAN; null when none. */
async function resolveBankAccountByIban(organizationId: string, propertyId: string, iban: string): Promise<string | null> {
  const normalised = iban.replace(/\s+/g, "").toUpperCase();
  const accounts = await prisma.bankAccount.findMany({ where: { organizationId, active: true }, select: { id: true, iban: true, propertyId: true } });
  return accounts.find((a) => bankAccountServesCentre(a, propertyId) && (a.iban ?? "").replace(/\s+/g, "").toUpperCase() === normalised)?.id ?? null;
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
  requireAnyPermission(input.context, REMITTANCE_WRITE_KEYS);
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
 *
 * Separation of duties (Tanda CIERRE-1 · T9 deuda 17d): every payable bill
 * goes through `assertSupplierBillPaymentAuthorized`, the same gate as
 * `POST …/supplier-bills/:id/pay` — the registrar of a bill cannot order its
 * payment by remittance (409 RBAC_SOD_CONFLICT `creator_ne_payer`) and neither
 * can its approver (`approver_ne_payer`) unless the actor is a controller in
 * the centre (audited exception). Fail-closed: one conflicting bill refuses
 * the WHOLE remittance (never `skipped`), so nothing is built nor persisted;
 * platform admins and break-glass sessions pass as `privileged`.
 *
 * The result also lists the bills that enter the remittance (`billIds`) and
 * the gate outcome of each (`sod`), and the built body carries them as
 * provenance so `createRemittance` persists and audits them (corrector
 * CIERRE-1 · REV-01).
 */
export async function buildSupplierPaymentRemittance(input: { context: UserContext; propertyId: string; bankAccountId: string; billIds: string[]; executionDate: string }): Promise<{ body: SepaTransferRemittance; skipped: Array<{ billId: string; reason: string }>; totalAmount: string; billIds: string[]; sod: SupplierPaymentSod[] }> {
  requireAnyPermission(input.context, REMITTANCE_WRITE_KEYS);
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("La propiedad no existe.");
  // The payer account is the centre's or the sociedad's (no centre); another centre's → opaque 404.
  const account = await prisma.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account || account.organizationId !== property.organizationId || !bankAccountServesCentre(account, input.propertyId)) throw new NotFoundError("La cuenta bancaria no existe en esta propiedad.");
  if (!account.iban) throw new ConflictError("La cuenta bancaria ordenante no tiene IBAN.", { code: "BANK_ACCOUNT_WITHOUT_IBAN" });
  // Ordenante = the sociedad (R2): razón social and NIF from the single identity reader.
  const identity = await requireLegalIdentity(account.organizationId);
  if (!identity.taxId || !identity.taxIdValid) {
    throw new ConflictError("La sociedad no tiene un NIF válido: complétalo en Configuración › Estructura societaria › Datos fiscales antes de generar la remesa.", {
      code: "ISSUER_TAX_ID_MISSING",
      legalEntityId: identity.legalEntityId,
      taxId: identity.taxId
    });
  }
  const bills = await prisma.supplierBill.findMany({ where: { id: { in: input.billIds }, OR: [{ propertyId: input.propertyId }, { organizationId: account.organizationId }] } });
  const supplierIds = Array.from(new Set(bills.map((b) => b.supplierId).filter((id): id is string => Boolean(id))));
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, iban: true } }) : [];
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const skipped: Array<{ billId: string; reason: string }> = [];
  const creditors: SepaTransferRemittance["creditors"] = [];
  const billIds: string[] = [];
  const sod: SupplierPaymentSod[] = [];
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
    // SoD gate (Tanda CIERRE-1 · 17d): registrar ≠ payer, approver ≠ payer unless controller; a conflict is a 409 for the whole remittance.
    const gate = await assertSupplierBillPaymentAuthorized({
      context: input.context,
      bill: { id: bill.id, propertyId: bill.propertyId, createdByUserId: bill.createdByUserId ?? null, approvedBy: bill.approvedBy ?? null }
    });
    const supplier = bill.supplierId ? supplierById.get(bill.supplierId) : undefined;
    if (!supplier?.iban || !validateIban(supplier.iban)) {
      skipped.push({ billId: id, reason: "el proveedor no tiene IBAN válido" });
      continue;
    }
    creditors.push({ name: supplier.name, iban: supplier.iban, amount: money(bill.total), description: `Factura ${bill.invoiceNumber ?? bill.id}`, endToEndId: `SB-${bill.id}`.slice(0, 35), category: "SUPP" });
    billIds.push(bill.id);
    sod.push({ billId: bill.id, creator: gate.creator, approver: gate.approver, controllerException: gate.controllerException });
  }
  if (creditors.length === 0) throw new ConflictError("Ninguna factura seleccionada se puede pagar por remesa.", { code: "REMITTANCE_EMPTY", skipped });
  const body: SepaTransferRemittance = {
    executionDate: input.executionDate,
    debtor: { name: identity.legalName.slice(0, 70), taxId: identity.taxId, iban: account.iban, ...(account.bic ? { bic: account.bic } : {}) },
    creditors
  };
  supplierPaymentProvenance.set(body, { billIds, sod });
  return { body, skipped, totalAmount: money(sum(creditors.map((c) => dec(c.amount)))), billIds, sod };
}
