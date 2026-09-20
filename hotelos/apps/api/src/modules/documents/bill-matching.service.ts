// Documentos · cotejo factura–albarán a 2 vías, persistido (Tanda T9 · lote
// T9-09, diseño §7.2 «Cotejo a 2 vías» y §9 fila match).
//
// `POST /properties/:propertyId/payables/supplier-bills/:billId/match`
// { goodsReceiptIds?, auto? } → carga las líneas de la factura y las recepciones
// `received | matched` del mismo proveedor (supplierId o NIF) y centro — o las
// recepciones dadas —, lee las tolerancias de DocumentSettings (2 % / 0 / 1,00 €
// por defecto), llama al algoritmo puro `matchBillToReceipts` (matching.ts,
// T9-06b) y escribe el resultado:
//   · BillLineMatch (status `auto`, upsert por la unique
//     (supplierBillLineId, goodsReceiptLineId)); las filas `confirmed` /
//     `rejected` de una persona se respetan: la línea confirmada no se vuelve a
//     cotejar y el par rechazado no se vuelve a proponer;
//   · los `auto` de la factura que ya no salen se borran (re-cotejo tras editar);
//   · SupplierBill.matchStatus (none · partial · full · variance);
//   · GoodsReceipt.status → billed cuando TODAS sus líneas casan dentro de
//     tolerancia (o están confirmadas / cotejadas con otra factura), matched cuando
//     alguna; una línea con varianza no cuenta, así que una factura solo con
//     varianzas deja la recepción como estaba.
// Auditoría BILL_MATCHED (entidad supplier_bill). Respuesta
// SupplierBillMatchResponse { supplierBillId, matchStatus, matches[] }.
//
// Persistencia detrás de `BillMatchingStore` (interfaz estrecha) para que los
// unit tests la simulen en memoria (__tests__/bill-matching.test.mts); la
// implementación Prisma (`prismaBillMatchingStore`) la cubre la integración.
// El plan (`planBillMatch`) es puro e idempotente: dos ejecuciones seguidas
// producen los mismos upserts y ningún borrado.

import type { BillLineMatchDto, PermissionKey, SupplierBillMatchResponse, SupplierBillMatchStatus } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { dayOf, type Decimal } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { toBillLineMatchDto } from "./documents-dto.js";
import { matchBillToReceipts, matchStatusOf, type BillLineLike, type BillLineMatchDraft, type GoodsReceiptLike, type MatchTolerances, type NumberLike } from "./matching.js";
import { tolerancesOf } from "./validation.js";
import { GOODS_RECEIPT_NOT_FOUND } from "./goods-receipts.service.js";

export const BILL_MATCH_PERMISSION: PermissionKey = "procurement.manage";
export const BILL_MATCH_AUDIT_ACTION = "BILL_MATCHED";

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

export const supplierBillMatchSchema = z
  .object({
    goodsReceiptIds: z.array(z.string().trim().min(1).max(64)).min(1).max(50).optional(),
    auto: z.boolean().optional()
  })
  .strict();

// ---------------------------------------------------------------------------
// Formas que ve el planificador (independientes de Prisma)
// ---------------------------------------------------------------------------

export type BillLineForMatching = {
  id: string;
  lineNo: number;
  description: string;
  quantity: NumberLike | null;
  unitPrice: NumberLike | null;
  base: NumberLike | null;
  deliveryNoteRef: string | null;
};

export type BillForMatching = {
  id: string;
  organizationId: string;
  propertyId: string;
  supplierId: string | null;
  supplierTaxId: string | null;
  status: string;
  matchStatus: string;
  lines: BillLineForMatching[];
};

export type ReceiptLineForMatching = {
  id: string;
  lineNo: number;
  description: string;
  quantityReceived: NumberLike;
  unitPrice: NumberLike | null;
  base: NumberLike | null;
};

export type ReceiptForMatching = {
  id: string;
  propertyId: string;
  supplierId: string | null;
  supplierTaxId: string | null;
  deliveryNoteNumber: string;
  deliveryDate: string | null;
  status: string;
  lines: ReceiptLineForMatching[];
};

/** Fila BillLineMatch existente que toca a la factura o a las recepciones candidatas. */
export type ExistingMatch = {
  id: string;
  supplierBillId: string;
  supplierBillLineId: string;
  goodsReceiptLineId: string;
  status: string;
};

export type MatchUpsert = {
  supplierBillLineId: string;
  goodsReceiptLineId: string;
  matchedQuantity: string | null;
  matchedBase: string | null;
  quantityVariance: string | null;
  priceVariance: string | null;
  withinTolerance: boolean;
  matchedBy: string;
};

export type MatchPlan = {
  billId: string;
  matchStatus: SupplierBillMatchStatus;
  upserts: MatchUpsert[];
  /** Filas `auto` de esta factura que ya no salen del algoritmo. */
  deleteMatchIds: string[];
  receiptStatus: Array<{ goodsReceiptId: string; status: "matched" | "billed" }>;
  /** Líneas de factura (1-based) sin línea de albarán. */
  unmatchedBillLines: number[];
};

export type PlanBillMatchInput = {
  bill: BillForMatching;
  receipts: ReadonlyArray<ReceiptForMatching>;
  existing: ReadonlyArray<ExistingMatch>;
  tolerances: MatchTolerances;
  matchedBy: string;
};

const pairKey = (billLineId: string, receiptLineId: string): string => `${billLineId}|${receiptLineId}`;

/**
 * Plan puro del cotejo: qué filas escribir, cuáles borrar y qué estados quedan.
 * Respeta las decisiones humanas (confirmed / rejected) y las líneas de albarán
 * ya cotejadas con OTRAS facturas (no entran en el pool).
 */
export function planBillMatch(input: PlanBillMatchInput): MatchPlan {
  const { bill, tolerances } = input;
  const ownMatches = input.existing.filter((m) => m.supplierBillId === bill.id);
  const foreign = input.existing.filter((m) => m.supplierBillId !== bill.id && m.status !== "rejected");
  const consumedByOthers = new Set(foreign.map((m) => m.goodsReceiptLineId));
  const confirmed = ownMatches.filter((m) => m.status === "confirmed");
  const confirmedBillLines = new Set(confirmed.map((m) => m.supplierBillLineId));
  const confirmedReceiptLines = new Set(confirmed.map((m) => m.goodsReceiptLineId));
  const rejectedPairs = new Set(ownMatches.filter((m) => m.status === "rejected").map((m) => pairKey(m.supplierBillLineId, m.goodsReceiptLineId)));

  const billLines: BillLineLike[] = bill.lines
    .filter((line) => !confirmedBillLines.has(line.id))
    .map((line) => ({ id: line.id, lineNo: line.lineNo, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, base: line.base, deliveryNoteRef: line.deliveryNoteRef }));
  const pool: GoodsReceiptLike[] = input.receipts.map((receipt) => ({
    id: receipt.id,
    propertyId: receipt.propertyId,
    supplierId: receipt.supplierId,
    supplierTaxId: receipt.supplierTaxId,
    deliveryNoteNumber: receipt.deliveryNoteNumber,
    deliveryDate: receipt.deliveryDate,
    status: receipt.status,
    lines: receipt.lines
      .filter((line) => !consumedByOthers.has(line.id) && !confirmedReceiptLines.has(line.id))
      .map((line) => ({ id: line.id, lineNo: line.lineNo, description: line.description, quantityReceived: line.quantityReceived, unitPrice: line.unitPrice, base: line.base }))
  }));
  const cited = bill.lines.map((line) => line.deliveryNoteRef).filter((ref): ref is string => Boolean(ref));

  const result = matchBillToReceipts(billLines, pool, tolerances, { citedReferences: cited });
  const drafts: BillLineMatchDraft[] = result.matches.filter((draft) => draft.supplierBillLineId && !rejectedPairs.has(pairKey(draft.supplierBillLineId, draft.goodsReceiptLineId)));

  const upserts: MatchUpsert[] = drafts.map((draft) => ({
    supplierBillLineId: draft.supplierBillLineId!,
    goodsReceiptLineId: draft.goodsReceiptLineId,
    matchedQuantity: draft.matchedQuantity,
    matchedBase: draft.matchedBase,
    quantityVariance: draft.quantityVariance,
    priceVariance: draft.priceVariance,
    withinTolerance: draft.withinTolerance,
    matchedBy: input.matchedBy
  }));
  const proposed = new Set(upserts.map((u) => pairKey(u.supplierBillLineId, u.goodsReceiptLineId)));
  const deleteMatchIds = ownMatches.filter((m) => m.status === "auto" && !proposed.has(pairKey(m.supplierBillLineId, m.goodsReceiptLineId))).map((m) => m.id);

  const matchStatus = matchStatusOf(
    [...upserts.map((u) => ({ withinTolerance: u.withinTolerance })), ...confirmed.map(() => ({ withinTolerance: true }))],
    bill.lines.length
  );

  // Recepciones: cubierta = línea con cotejo dentro de tolerancia (esta ejecución), confirmado o cotejado con otra factura.
  const covered = new Set<string>([...upserts.filter((u) => u.withinTolerance).map((u) => u.goodsReceiptLineId), ...confirmedReceiptLines, ...consumedByOthers]);
  const receiptStatus: MatchPlan["receiptStatus"] = [];
  for (const receipt of input.receipts) {
    if (receipt.lines.length === 0) continue;
    const coveredLines = receipt.lines.filter((line) => covered.has(line.id)).length;
    const next: "matched" | "billed" | null = coveredLines === receipt.lines.length ? "billed" : coveredLines > 0 ? "matched" : null;
    if (next && next !== receipt.status && (receipt.status === "received" || receipt.status === "matched")) receiptStatus.push({ goodsReceiptId: receipt.id, status: next });
  }

  const unmatchedBillLines = bill.lines.filter((line) => !confirmedBillLines.has(line.id) && !upserts.some((u) => u.supplierBillLineId === line.id)).map((line) => line.lineNo);
  return { billId: bill.id, matchStatus, upserts, deleteMatchIds, receiptStatus, unmatchedBillLines };
}

// ---------------------------------------------------------------------------
// Almacén (interfaz estrecha; implementación Prisma y simulada en tests)
// ---------------------------------------------------------------------------

export type PersistedMatchRow = Parameters<typeof toBillLineMatchDto>[0];

export type BillMatchingStore = {
  loadBill(propertyId: string, billId: string): Promise<BillForMatching | null>;
  loadTolerances(organizationId: string): Promise<MatchTolerances>;
  /** Recepciones concretas del centro (cualquier estado; el servicio filtra). */
  loadReceiptsByIds(organizationId: string, propertyId: string, ids: ReadonlyArray<string>): Promise<ReceiptForMatching[]>;
  /** Recepciones `received | matched` del mismo proveedor (id o NIF) y centro. */
  loadOpenReceiptsOfSupplier(input: { organizationId: string; propertyId: string; supplierId: string | null; supplierTaxId: string | null }): Promise<ReceiptForMatching[]>;
  loadMatches(input: { billLineIds: ReadonlyArray<string>; receiptLineIds: ReadonlyArray<string> }): Promise<ExistingMatch[]>;
  /** Aplica el plan en una transacción y devuelve todas las filas BillLineMatch de la factura. */
  persist(plan: MatchPlan): Promise<PersistedMatchRow[]>;
};

type BillRow = Prisma.SupplierBillGetPayload<{ include: { lines: true } }>;
type ReceiptRow = Prisma.GoodsReceiptGetPayload<{ include: { lines: true } }>;

function decimalOrNull(value: Decimal | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : value;
}

function billFromRow(row: BillRow): BillForMatching {
  return {
    id: row.id,
    organizationId: row.organizationId ?? "",
    propertyId: row.propertyId,
    supplierId: row.supplierId ?? null,
    supplierTaxId: row.supplierTaxId ?? null,
    status: row.status,
    matchStatus: row.matchStatus,
    lines: [...row.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((line) => ({ id: line.id, lineNo: line.lineNo, description: line.description, quantity: decimalOrNull(line.quantity), unitPrice: decimalOrNull(line.unitPrice), base: line.base, deliveryNoteRef: line.deliveryNoteRef ?? null }))
  };
}

function receiptFromRow(row: ReceiptRow): ReceiptForMatching {
  return {
    id: row.id,
    propertyId: row.propertyId,
    supplierId: row.supplierId,
    supplierTaxId: row.supplierTaxId,
    deliveryNoteNumber: row.deliveryNoteNumber,
    deliveryDate: dayOf(row.deliveryDate),
    status: row.status,
    lines: [...row.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((line) => ({ id: line.id, lineNo: line.lineNo, description: line.description, quantityReceived: line.quantityReceived, unitPrice: decimalOrNull(line.unitPrice), base: decimalOrNull(line.base) }))
  };
}

export const prismaBillMatchingStore: BillMatchingStore = {
  async loadBill(propertyId, billId) {
    const row = await prisma.supplierBill.findFirst({ where: { id: billId, propertyId }, include: { lines: true } });
    return row ? billFromRow(row) : null;
  },
  async loadTolerances(organizationId) {
    const settings = await prisma.documentSettings.findUnique({ where: { organizationId }, select: { priceTolerancePct: true, quantityTolerance: true, amountToleranceAbs: true } });
    return tolerancesOf(settings);
  },
  async loadReceiptsByIds(organizationId, propertyId, ids) {
    const rows = await prisma.goodsReceipt.findMany({ where: { id: { in: [...ids] }, organizationId, propertyId }, include: { lines: true } });
    return rows.map(receiptFromRow);
  },
  async loadOpenReceiptsOfSupplier({ organizationId, propertyId, supplierId, supplierTaxId }) {
    const or: Prisma.GoodsReceiptWhereInput[] = [...(supplierId ? [{ supplierId }] : []), ...(supplierTaxId ? [{ supplierTaxId }] : [])];
    if (or.length === 0) return [];
    const rows = await prisma.goodsReceipt.findMany({
      where: { organizationId, propertyId, status: { in: ["received", "matched"] }, OR: or },
      include: { lines: true },
      orderBy: [{ deliveryDate: "desc" }, { id: "desc" }],
      take: 100
    });
    return rows.map(receiptFromRow);
  },
  async loadMatches({ billLineIds, receiptLineIds }) {
    const or: Prisma.BillLineMatchWhereInput[] = [
      ...(billLineIds.length ? [{ supplierBillLineId: { in: [...billLineIds] } }] : []),
      ...(receiptLineIds.length ? [{ goodsReceiptLineId: { in: [...receiptLineIds] } }] : [])
    ];
    if (or.length === 0) return [];
    const rows = await prisma.billLineMatch.findMany({ where: { OR: or }, include: { supplierBillLine: { select: { supplierBillId: true } } } });
    return rows.map((row) => ({ id: row.id, supplierBillId: row.supplierBillLine.supplierBillId, supplierBillLineId: row.supplierBillLineId, goodsReceiptLineId: row.goodsReceiptLineId, status: row.status }));
  },
  async persist(plan) {
    return prisma.$transaction(async (tx) => {
      if (plan.deleteMatchIds.length) await tx.billLineMatch.deleteMany({ where: { id: { in: plan.deleteMatchIds }, status: "auto" } });
      for (const upsert of plan.upserts) {
        const values = {
          matchedQuantity: upsert.matchedQuantity,
          matchedBase: upsert.matchedBase,
          quantityVariance: upsert.quantityVariance,
          priceVariance: upsert.priceVariance,
          status: "auto",
          matchedBy: upsert.matchedBy
        };
        await tx.billLineMatch.upsert({
          where: { supplierBillLineId_goodsReceiptLineId: { supplierBillLineId: upsert.supplierBillLineId, goodsReceiptLineId: upsert.goodsReceiptLineId } },
          create: { supplierBillLineId: upsert.supplierBillLineId, goodsReceiptLineId: upsert.goodsReceiptLineId, ...values },
          update: values
        });
      }
      await tx.supplierBill.update({ where: { id: plan.billId }, data: { matchStatus: plan.matchStatus } });
      for (const change of plan.receiptStatus) {
        await tx.goodsReceipt.update({ where: { id: change.goodsReceiptId }, data: { status: change.status } });
      }
      return tx.billLineMatch.findMany({ where: { supplierBillLine: { supplierBillId: plan.billId } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    });
  }
};

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type MatchSupplierBillInput = {
  context: UserContext;
  propertyId: string;
  billId: string;
  body: unknown;
  correlationId?: string;
};

export type BillMatchingServiceDeps = {
  store?: BillMatchingStore;
  audit?: typeof recordAuditEvent;
};

export function createBillMatchingService(deps: BillMatchingServiceDeps = {}) {
  const store = deps.store ?? prismaBillMatchingStore;
  const audit = deps.audit ?? recordAuditEvent;

  async function matchSupplierBill(input: MatchSupplierBillInput): Promise<SupplierBillMatchResponse> {
    requirePermissions(input.context, [BILL_MATCH_PERMISSION]);
    const body = parseOr400(supplierBillMatchSchema, input.body ?? {}, "Cotejo");
    if (!body.goodsReceiptIds && body.auto === false) throw typed(400, "VALIDATION_ERROR", "Cotejo no válido: indica goodsReceiptIds o auto: true.");

    const bill = await store.loadBill(input.propertyId, input.billId);
    if (!bill) throw new NotFoundError("Factura recibida no encontrada.");
    if (bill.status === "cancelled") throw typed(409, "INVALID_STATUS_TRANSITION", "No se puede cotejar una factura anulada.", { status: bill.status });

    const tolerances = await store.loadTolerances(bill.organizationId);

    let receipts: ReceiptForMatching[];
    if (body.goodsReceiptIds) {
      const wanted = [...new Set(body.goodsReceiptIds)];
      const found = await store.loadReceiptsByIds(bill.organizationId, input.propertyId, wanted);
      const missing = wanted.filter((id) => !found.some((receipt) => receipt.id === id));
      if (missing.length) throw new NotFoundError(GOODS_RECEIPT_NOT_FOUND);
      // Por id se admite también una recepción `billed` (re-cotejo de la misma factura, idempotente:
      // sus líneas cotejadas con OTRAS facturas no entran en el pool); solo la disputada se rechaza.
      const notMatchable = found.filter((receipt) => receipt.status === "disputed");
      if (notMatchable.length) {
        throw typed(409, "INVALID_STATUS_TRANSITION", "No se coteja una recepción disputada.", {
          goodsReceiptIds: notMatchable.map((receipt) => receipt.id),
          statuses: notMatchable.map((receipt) => receipt.status)
        });
      }
      receipts = found;
    } else {
      if (!bill.supplierId && !bill.supplierTaxId) throw typed(400, "SUPPLIER_REQUIRED", "La factura no tiene proveedor ni NIF: indica goodsReceiptIds.");
      receipts = await store.loadOpenReceiptsOfSupplier({ organizationId: bill.organizationId, propertyId: input.propertyId, supplierId: bill.supplierId, supplierTaxId: bill.supplierTaxId });
    }

    const existing = await store.loadMatches({ billLineIds: bill.lines.map((line) => line.id), receiptLineIds: receipts.flatMap((receipt) => receipt.lines.map((line) => line.id)) });
    const plan = planBillMatch({ bill, receipts, existing, tolerances, matchedBy: input.context.userId });
    const matchStatusBefore = bill.matchStatus;
    const rows = await store.persist(plan);
    const matches: BillLineMatchDto[] = rows.map(toBillLineMatchDto);

    audit({
      organizationId: bill.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: BILL_MATCH_AUDIT_ACTION,
      entityType: "supplier_bill",
      entityId: bill.id,
      beforeJson: { matchStatus: matchStatusBefore },
      afterJson: {
        matchStatus: plan.matchStatus,
        matches: matches.length,
        proposed: plan.upserts.length,
        removed: plan.deleteMatchIds.length,
        goodsReceiptIds: receipts.map((receipt) => receipt.id),
        receiptStatus: plan.receiptStatus,
        unmatchedBillLines: plan.unmatchedBillLines
      },
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {})
    });

    return { supplierBillId: bill.id, matchStatus: plan.matchStatus, matches };
  }

  return { matchSupplierBill };
}

const defaultService = createBillMatchingService();

/** Contrato cruzado (rutas de payables): `matchSupplierBill({ context, propertyId, billId, body: { goodsReceiptIds?, auto? } })`. */
export const matchSupplierBill = defaultService.matchSupplierBill;
