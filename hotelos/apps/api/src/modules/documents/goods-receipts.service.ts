// Documentos · recepciones de mercancía / albaranes (Tanda T9 · lote T9-09,
// diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §7.2 «Albarán → GoodsReceipt»,
// §8 GoodsReceipt / GoodsReceiptLine y §9 filas goods-receipts).
//
// Qué hace:
//   · alta de una recepción (cabecera + líneas) con unicidad
//     (organización, proveedor, nº de albarán) → 409 GOODS_RECEIPT_DUPLICATE
//     (comparación por número normalizado además del índice único de la tabla,
//     que no cubre las recepciones sin supplierId: NULL ≠ NULL en Postgres);
//   · movimiento de stock `receipt` (sourceType "goods_receipt") EN LA MISMA
//     transacción cuando la línea lleva `inventoryItemId` y la petición
//     `stockLocationId` (ambos NOT NULL en StockMovement); sin ubicación no hay
//     movimiento y la línea queda stockMovementId = null;
//   · resolución del artículo de inventario por id explícito o por coincidencia
//     EXACTA (sku o nombre normalizado) con los artículos activos del centro;
//     ambigüedad o ausencia → sin enlace (nunca se inventa);
//   · lista paginada (lib/pagination.ts), detalle con líneas y cotejos, disputa
//     ({ reason } → disputed) y auditoría GOODS_RECEIPT_CREATED / _DISPUTED.
//
// Contrato cruzado: `createGoodsReceiptInTx(tx, …)` lo usa la aprobación de
// documentos (T9-08, `create_goods_receipt`) dentro de su propia transacción;
// `createGoodsReceipt` (HTTP) abre la suya y audita. Las funciones puras
// (normalización, duplicado, artículo, movimientos, disputa) se exportan para
// los unit tests (__tests__/goods-receipts.test.mts).
//
// Importes como Prisma.Decimal (payables/money.ts): cantidades con 3 decimales,
// precios con 4, bases con 2; StockMovement.quantity / unitCost son Decimal(12,2),
// así que el movimiento recibe la cantidad y el coste redondeados al céntimo
// (una cantidad que redondee a 0,00 no puede entrar en el inventario → 400).

import type { GoodsReceiptDetail, GoodsReceiptLineDto, GoodsReceiptRecord, GoodsReceiptStatus, PermissionKey } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { buildPage, decodeCursor, parsePageQuery, type Page, type PageQuery } from "../../lib/pagination.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordStockMovement } from "../fnb-inventory/fnb-inventory.service.js";
import { dayInput, dayOf, dec, money, moneyInput, percentInput, round2, ZERO, type Decimal } from "../payables/money.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { requireSupplier, resolveSupplierTaxId } from "../payables/suppliers.service.js";
import { toBillLineMatchDto } from "./documents-dto.js";
import { lineBase, normalizeDescription, normalizeReference } from "./matching.js";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const GOODS_RECEIPT_NOT_FOUND = "Recepción de mercancía no encontrada.";
export const GOODS_RECEIPT_AUDIT_ENTITY = "goods_receipt";
export const GOODS_RECEIPT_AUDIT_ACTIONS = Object.freeze({
  created: "GOODS_RECEIPT_CREATED",
  disputed: "GOODS_RECEIPT_DISPUTED"
} as const);

/** Clave del alta, la disputa y el cotejo (diseño §9); las lecturas van por inventory.read en el manifiesto. */
export const GOODS_RECEIPT_MANAGE_PERMISSION: PermissionKey = "procurement.manage";

/** Estados desde los que se puede disputar (una recepción facturada o ya disputada no cambia). */
export const GOODS_RECEIPT_DISPUTABLE_STATUSES: ReadonlySet<GoodsReceiptStatus> = new Set<GoodsReceiptStatus>(["received", "matched"]);

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

// ---------------------------------------------------------------------------
// Esquemas zod (cuerpo de POST …/goods-receipts, …/dispute y query de la lista)
// ---------------------------------------------------------------------------

const DECIMAL_STRING = /^-?\d{1,12}(\.\d{1,6})?$/;

/** Decimal con escala máxima `scale` (3 cantidades, 4 precios), mínimo 0 y, opcionalmente, distinto de cero. */
function decimalInput(scale: number, options: { allowZero?: boolean } = {}): z.ZodType<Decimal, z.ZodTypeDef, string | number> {
  const allowZero = options.allowZero ?? true;
  return z
    .union([z.number().finite(), z.string().regex(DECIMAL_STRING, "número no válido")])
    .transform((raw, ctx) => {
      const value = dec(raw);
      if (value.decimalPlaces() > scale) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `no puede tener más de ${scale} decimales` });
        return z.NEVER;
      }
      if (value.lt(ZERO)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "no puede ser negativo" });
        return z.NEVER;
      }
      if (!allowZero && value.isZero()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "no puede ser cero" });
        return z.NEVER;
      }
      return value;
    });
}

export const goodsReceiptLineSchema = z
  .object({
    description: z.string().trim().min(1, "obligatorio").max(300),
    quantityReceived: decimalInput(3, { allowZero: false }),
    unit: z.string().trim().min(1).max(20).nullable().optional(),
    unitPrice: decimalInput(4).nullable().optional(),
    base: moneyInput().nullable().optional(),
    taxRate: percentInput().nullable().optional(),
    inventoryItemId: z.string().trim().min(1).max(64).nullable().optional(),
    purchaseOrderLineId: z.string().trim().min(1).max(64).nullable().optional(),
    quantityOrdered: decimalInput(3).nullable().optional()
  })
  .strict();

export const goodsReceiptSchema = z
  .object({
    supplierId: z.string().trim().min(1).max(64).nullable().optional(),
    supplierName: z.string().trim().min(1).max(200).optional(),
    supplierTaxId: z.string().trim().max(20).nullable().optional(),
    deliveryNoteNumber: z.string().trim().min(1, "obligatorio").max(60),
    deliveryDate: dayInput(),
    purchaseOrderId: z.string().trim().min(1).max(64).nullable().optional(),
    receivedBy: z.string().trim().min(1).max(120).nullable().optional(),
    stockLocationId: z.string().trim().min(1).max(64).nullable().optional(),
    note: z.string().trim().max(1000).optional(),
    lines: z.array(goodsReceiptLineSchema).min(1, "la recepción necesita al menos una línea").max(200)
  })
  .strict();

export const goodsReceiptDisputeSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha AAAA-MM-DD");
export const goodsReceiptListQuerySchema = z
  .object({
    status: z.enum(["received", "matched", "billed", "disputed"]).optional(),
    supplierId: z.string().trim().min(1).max(64).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    q: z.string().trim().max(120).optional(),
    limit: z.union([z.string(), z.number()]).optional(),
    cursor: z.string().optional(),
    envelope: z.union([z.string(), z.number()]).optional()
  })
  .strict();

export type GoodsReceiptInput = z.output<typeof goodsReceiptSchema>;
export type GoodsReceiptLineInput = z.output<typeof goodsReceiptLineSchema>;

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los unit tests)
// ---------------------------------------------------------------------------

/** Nº de albarán comparable: solo alfanuméricos en minúsculas («ALB-2026/0042» ≡ «alb 2026 0042»). */
export function normalizeDeliveryNoteNumber(value: string | null | undefined): string {
  return normalizeReference(value);
}

export type ReceiptIdentity = {
  id?: string;
  supplierId: string | null;
  supplierTaxId: string | null;
  deliveryNoteNumber: string;
};

/**
 * Duplicado por (organización, proveedor, nº de albarán normalizado): mismo
 * supplierId; sin supplierId, mismo NIF; sin ninguno de los dos, la fila
 * también sin proveedor. Devuelve la recepción existente o null.
 */
export function findDuplicateReceipt<T extends ReceiptIdentity>(existing: ReadonlyArray<T>, candidate: ReceiptIdentity): T | null {
  const number = normalizeDeliveryNoteNumber(candidate.deliveryNoteNumber);
  if (number.length === 0) return null;
  for (const row of existing) {
    if (candidate.id && row.id === candidate.id) continue;
    if (normalizeDeliveryNoteNumber(row.deliveryNoteNumber) !== number) continue;
    if (candidate.supplierId) {
      if (row.supplierId === candidate.supplierId) return row;
      continue;
    }
    if (candidate.supplierTaxId) {
      if (!row.supplierId && row.supplierTaxId === candidate.supplierTaxId) return row;
      continue;
    }
    if (!row.supplierId && !row.supplierTaxId) return row;
  }
  return null;
}

export type InventoryItemLike = { id: string; name: string; sku: string | null; active?: boolean };

/**
 * Artículo de inventario de una línea: el id explícito si existe entre los del
 * centro; si no hay id, coincidencia EXACTA por sku (sin mayúsculas ni espacios)
 * o por nombre normalizado con un único artículo activo. Varias coincidencias o
 * ninguna → null (nunca se adivina). Un id explícito desconocido → `"invalid"`.
 */
export function resolveInventoryItem(line: { inventoryItemId?: string | null; description: string }, items: ReadonlyArray<InventoryItemLike>): string | null | "invalid" {
  if (line.inventoryItemId) {
    return items.some((item) => item.id === line.inventoryItemId) ? line.inventoryItemId : "invalid";
  }
  const active = items.filter((item) => item.active !== false);
  const wanted = normalizeDescription(line.description);
  if (wanted.length === 0) return null;
  const bySku = active.filter((item) => item.sku && normalizeDescription(item.sku) === wanted);
  if (bySku.length === 1) return bySku[0]!.id;
  if (bySku.length > 1) return null;
  const byName = active.filter((item) => normalizeDescription(item.name) === wanted);
  return byName.length === 1 ? byName[0]!.id : null;
}

export type StockMovementDraft = {
  lineNo: number;
  inventoryItemId: string;
  stockLocationId: string;
  /** Decimal(12,2) de StockMovement: la cantidad recibida redondeada al céntimo. */
  quantity: number;
  unitCost: number | null;
};

/**
 * Movimientos `receipt` que genera una recepción: uno por línea con artículo
 * cuando la petición trae ubicación; sin ubicación, ninguno. Una cantidad que
 * redondea a 0,00 no cabe en StockMovement.quantity → 400.
 */
export function stockMovementsFor(
  lines: ReadonlyArray<{ lineNo: number; inventoryItemId: string | null; quantityReceived: Decimal | string | number; unitPrice?: Decimal | string | number | null }>,
  stockLocationId: string | null | undefined
): StockMovementDraft[] {
  if (!stockLocationId) return [];
  const drafts: StockMovementDraft[] = [];
  for (const line of lines) {
    if (!line.inventoryItemId) continue;
    const quantity = round2(line.quantityReceived);
    if (quantity.isZero()) {
      throw typed(400, "STOCK_QUANTITY_TOO_SMALL", `Línea ${line.lineNo}: la cantidad recibida redondea a 0,00 y no puede entrar en el inventario (2 decimales).`, { lineNo: line.lineNo });
    }
    const unitCost = line.unitPrice === null || line.unitPrice === undefined ? null : Number(round2(line.unitPrice).toFixed(2));
    drafts.push({ lineNo: line.lineNo, inventoryItemId: line.inventoryItemId, stockLocationId, quantity: Number(quantity.toFixed(2)), unitCost });
  }
  return drafts;
}

/** Transición de disputa: `received` / `matched` → `disputed`; el resto no cambia (409). */
export function disputeTransition(status: GoodsReceiptStatus): { ok: true; next: "disputed" } | { ok: false; reason: string } {
  if (GOODS_RECEIPT_DISPUTABLE_STATUSES.has(status)) return { ok: true, next: "disputed" };
  if (status === "disputed") return { ok: false, reason: "La recepción ya está disputada." };
  return { ok: false, reason: "No se puede disputar una recepción ya facturada." };
}

/** Nota de la recepción con la disputa añadida (la nota previa se conserva). */
export function noteWithDispute(note: string | null | undefined, reason: string): string {
  const prefix = note && note.trim().length > 0 ? `${note.trim()} · ` : "";
  return `${prefix}Disputa: ${reason.trim()}`;
}

/** Nombre libre del proveedor cuando no hay Supplier enlazado: se conserva en la nota (GoodsReceipt no tiene columna supplierName). */
export function noteWithSupplierName(note: string | null | undefined, supplierName: string | null | undefined): string | null {
  const base = note && note.trim().length > 0 ? note.trim() : null;
  const name = supplierName && supplierName.trim().length > 0 ? supplierName.trim() : null;
  if (!name) return base;
  const tag = `Proveedor: ${name}`;
  if (base && base.includes(tag)) return base;
  return base ? `${tag} · ${base}` : tag;
}

/** Base de una línea de recepción (la dada o cantidad × precio), 2 decimales, o null. */
export function receiptLineBase(line: { base?: Decimal | string | number | null; quantityReceived: Decimal | string | number; unitPrice?: Decimal | string | number | null }): Decimal | null {
  return lineBase({ base: line.base ?? null, quantity: line.quantityReceived, unitPrice: line.unitPrice ?? null });
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

type ReceiptRow = Prisma.GoodsReceiptGetPayload<{ include: { lines: true } }>;
type LineRow = ReceiptRow["lines"][number];
type MatchRow = Prisma.BillLineMatchGetPayload<{ include: { supplierBillLine: { select: { supplierBillId: true } } } }>;

export type ReceiptExtras = { supplierName: string | null; registryNumber: string | null; receivedByName?: string | null };

function decimalString(value: Decimal | null | undefined, scale: number): string | null {
  return value === null || value === undefined ? null : dec(value).toFixed(scale);
}

export function toGoodsReceiptLineDto(row: LineRow): GoodsReceiptLineDto {
  return {
    id: row.id,
    lineNo: row.lineNo,
    description: row.description,
    inventoryItemId: row.inventoryItemId,
    purchaseOrderLineId: row.purchaseOrderLineId,
    quantityOrdered: decimalString(row.quantityOrdered, 3),
    quantityReceived: dec(row.quantityReceived).toFixed(3),
    unit: row.unit,
    unitPrice: decimalString(row.unitPrice, 4),
    base: row.base === null ? null : money(row.base),
    taxRate: decimalString(row.taxRate, 2),
    stockMovementId: row.stockMovementId
  };
}

export function toGoodsReceiptRecord(row: ReceiptRow, extras: ReceiptExtras): GoodsReceiptRecord {
  let baseTotal = ZERO;
  for (const line of row.lines) {
    const base = receiptLineBase(line);
    if (base !== null) baseTotal = baseTotal.plus(base);
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    supplierId: row.supplierId,
    supplierName: extras.supplierName,
    supplierTaxId: row.supplierTaxId,
    deliveryNoteNumber: row.deliveryNoteNumber,
    deliveryDate: dayOf(row.deliveryDate) ?? "",
    purchaseOrderId: row.purchaseOrderId,
    status: row.status as GoodsReceiptStatus,
    receivedBy: row.receivedBy,
    receivedByName: extras.receivedByName ?? null,
    incomingDocumentId: row.incomingDocumentId,
    registryNumber: extras.registryNumber,
    note: row.note,
    lineCount: row.lines.length,
    baseTotal: money(baseTotal),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toGoodsReceiptDetail(row: ReceiptRow, extras: ReceiptExtras, matches: ReadonlyArray<MatchRow>): GoodsReceiptDetail {
  const supplierBillIds = [...new Set(matches.map((match) => match.supplierBillLine.supplierBillId))];
  return {
    ...toGoodsReceiptRecord(row, extras),
    lines: [...row.lines].sort((a, b) => a.lineNo - b.lineNo).map(toGoodsReceiptLineDto),
    matches: matches.map(toBillLineMatchDto),
    supplierBillIds
  };
}

// ---------------------------------------------------------------------------
// Helpers de persistencia
// ---------------------------------------------------------------------------

async function organizationOfProperty(db: Db, propertyId: string): Promise<string> {
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property.organizationId;
}

async function requireReceipt(db: Db, propertyId: string, receiptId: string): Promise<ReceiptRow> {
  const row = await db.goodsReceipt.findFirst({ where: { id: receiptId, propertyId }, include: { lines: true } });
  if (!row) throw new NotFoundError(GOODS_RECEIPT_NOT_FOUND);
  return row;
}

async function extrasFor(db: Db, rows: ReadonlyArray<ReceiptRow>): Promise<Map<string, ReceiptExtras>> {
  const supplierIds = [...new Set(rows.map((row) => row.supplierId).filter((id): id is string => Boolean(id)))];
  const documentIds = [...new Set(rows.map((row) => row.incomingDocumentId).filter((id): id is string => Boolean(id)))];
  // RV-16: `receivedBy` guarda el id de usuario cuando la recepción nace de un documento (context.userId); se resuelve el nombre.
  const receiverIds = [...new Set(rows.map((row) => row.receivedBy).filter((id): id is string => Boolean(id)))];
  const [suppliers, documents, receivers] = await Promise.all([
    supplierIds.length ? db.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    documentIds.length ? db.incomingDocument.findMany({ where: { id: { in: documentIds } }, select: { id: true, registryNumber: true } }) : Promise.resolve([]),
    receiverIds.length ? db.user.findMany({ where: { id: { in: receiverIds } }, select: { id: true, fullName: true } }) : Promise.resolve([])
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const registry = new Map(documents.map((d) => [d.id, d.registryNumber]));
  const receiverName = new Map(receivers.map((u) => [u.id, u.fullName]));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        supplierName: row.supplierId ? (supplierName.get(row.supplierId) ?? null) : null,
        registryNumber: row.incomingDocumentId ? (registry.get(row.incomingDocumentId) ?? null) : null,
        receivedByName: row.receivedBy ? (receiverName.get(row.receivedBy) ?? null) : null
      }
    ])
  );
}

async function matchesOf(db: Db, lineIds: ReadonlyArray<string>): Promise<MatchRow[]> {
  if (lineIds.length === 0) return [];
  return db.billLineMatch.findMany({
    where: { goodsReceiptLineId: { in: [...lineIds] } },
    include: { supplierBillLine: { select: { supplierBillId: true } } },
    orderBy: { createdAt: "asc" }
  });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------
// Alta (transacción del llamador) — contrato cruzado con T9-08
// ---------------------------------------------------------------------------

export type CreateGoodsReceiptInTxInput = {
  organizationId: string;
  propertyId: string;
  /** Quién recibe (id de usuario o nombre); `body.receivedBy` prevalece. */
  receivedBy: string | null;
  incomingDocumentId?: string | null;
  /** GoodsReceiptRequest sin validar (se valida aquí con goodsReceiptSchema). */
  body: unknown;
};

/**
 * Crea la recepción (cabecera, líneas y movimientos de stock) con el `tx` del
 * llamador. Lanza 400 VALIDATION_ERROR / SUPPLIER_REQUIRED / SUPPLIER_NIF_INVALID /
 * INVENTORY_ITEM_INVALID / STOCK_LOCATION_INVALID / STOCK_QUANTITY_TOO_SMALL,
 * 404 (proveedor) y 409 GOODS_RECEIPT_DUPLICATE. No audita: lo hace el llamador
 * (createGoodsReceipt aquí, la aprobación del documento en T9-08).
 */
export async function createGoodsReceiptInTx(tx: Tx, input: CreateGoodsReceiptInTxInput): Promise<GoodsReceiptDetail> {
  const data = parseOr400(goodsReceiptSchema, input.body ?? {}, "Recepción de mercancía");
  const { organizationId, propertyId } = input;

  // Proveedor: id (debe ser de la organización) o NIF (+ enlace al Supplier con ese NIF si es único) o nombre libre.
  let supplierId: string | null = null;
  let supplierTaxId: string | null = null;
  let supplierName: string | null = data.supplierName ?? null;
  if (data.supplierId) {
    const supplier = await requireSupplier(tx, organizationId, data.supplierId);
    supplierId = supplier.id;
    supplierName = supplier.name;
    supplierTaxId = data.supplierTaxId !== undefined && data.supplierTaxId !== null ? resolveSupplierTaxId(data.supplierTaxId, supplier.countryCode).taxId : supplier.taxId;
  } else {
    supplierTaxId = resolveSupplierTaxId(data.supplierTaxId, "ES").taxId;
    if (!supplierTaxId && !supplierName) throw typed(400, "SUPPLIER_REQUIRED", "Indica supplierId, supplierTaxId o supplierName.");
    if (supplierTaxId) {
      const byTaxId = await tx.supplier.findMany({ where: { organizationId, taxId: supplierTaxId, active: true }, select: { id: true, name: true }, take: 2 });
      if (byTaxId.length === 1) {
        supplierId = byTaxId[0]!.id;
        supplierName = byTaxId[0]!.name;
      }
    }
  }

  // Unicidad (organización, proveedor, nº de albarán) por número normalizado.
  const candidates = await tx.goodsReceipt.findMany({
    where: {
      organizationId,
      ...(supplierId ? { supplierId } : supplierTaxId ? { supplierId: null, supplierTaxId } : { supplierId: null, supplierTaxId: null })
    },
    select: { id: true, supplierId: true, supplierTaxId: true, deliveryNoteNumber: true, status: true }
  });
  const duplicate = findDuplicateReceipt(candidates, { supplierId, supplierTaxId, deliveryNoteNumber: data.deliveryNoteNumber });
  if (duplicate) {
    throw typed(409, "GOODS_RECEIPT_DUPLICATE", `Ya existe una recepción del mismo proveedor con el albarán «${duplicate.deliveryNoteNumber}».`, {
      goodsReceiptId: duplicate.id,
      deliveryNoteNumber: duplicate.deliveryNoteNumber,
      status: duplicate.status
    });
  }

  // Ubicación de stock (del centro y activa) y artículos del centro.
  if (data.stockLocationId) {
    const location = await tx.stockLocation.findFirst({ where: { id: data.stockLocationId, propertyId, active: true }, select: { id: true } });
    if (!location) throw typed(400, "STOCK_LOCATION_INVALID", "La ubicación de stock no existe en este centro o está inactiva.", { stockLocationId: data.stockLocationId });
  }
  const items = await tx.inventoryItem.findMany({ where: { propertyId }, select: { id: true, name: true, sku: true, active: true } });
  const lines = data.lines.map((line, index) => {
    const resolved = resolveInventoryItem(line, items);
    if (resolved === "invalid") {
      throw typed(400, "INVENTORY_ITEM_INVALID", `Línea ${index + 1}: el artículo de inventario no existe en este centro.`, { lineNo: index + 1, inventoryItemId: line.inventoryItemId });
    }
    return { lineNo: index + 1, ...line, inventoryItemId: resolved };
  });
  const movements = stockMovementsFor(lines, data.stockLocationId ?? null);

  let created: ReceiptRow;
  try {
    created = await tx.goodsReceipt.create({
      data: {
        organizationId,
        propertyId,
        supplierId,
        supplierTaxId,
        deliveryNoteNumber: data.deliveryNoteNumber,
        deliveryDate: data.deliveryDate,
        purchaseOrderId: data.purchaseOrderId ?? null,
        status: "received",
        receivedBy: data.receivedBy ?? input.receivedBy ?? null,
        incomingDocumentId: input.incomingDocumentId ?? null,
        note: noteWithSupplierName(data.note, supplierId ? null : supplierName),
        lines: {
          create: lines.map((line) => ({
            lineNo: line.lineNo,
            description: line.description,
            inventoryItemId: line.inventoryItemId,
            purchaseOrderLineId: line.purchaseOrderLineId ?? null,
            quantityOrdered: line.quantityOrdered ?? null,
            quantityReceived: line.quantityReceived,
            unit: line.unit ?? null,
            unitPrice: line.unitPrice ?? null,
            base: line.base ?? null,
            taxRate: line.taxRate ?? null
          }))
        }
      },
      include: { lines: true }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw typed(409, "GOODS_RECEIPT_DUPLICATE", `Ya existe una recepción del mismo proveedor con el albarán «${data.deliveryNoteNumber}».`, { deliveryNoteNumber: data.deliveryNoteNumber });
    }
    throw error;
  }

  // Movimientos de stock en la misma transacción (sourceType goods_receipt / sourceId recepción).
  const lineByNo = new Map(created.lines.map((line) => [line.lineNo, line]));
  for (const movement of movements) {
    const line = lineByNo.get(movement.lineNo);
    if (!line) continue;
    const stockMovement = await recordStockMovement(
      {
        propertyId,
        inventoryItemId: movement.inventoryItemId,
        stockLocationId: movement.stockLocationId,
        movementType: "receipt",
        quantity: movement.quantity,
        ...(movement.unitCost === null ? {} : { unitCost: movement.unitCost }),
        sourceType: "goods_receipt",
        sourceId: created.id
      },
      tx
    );
    await tx.goodsReceiptLine.update({ where: { id: line.id }, data: { stockMovementId: stockMovement.id } });
    line.stockMovementId = stockMovement.id;
  }

  const extras: ReceiptExtras = { supplierName, registryNumber: null };
  if (input.incomingDocumentId) {
    const document = await tx.incomingDocument.findUnique({ where: { id: input.incomingDocumentId }, select: { registryNumber: true } });
    extras.registryNumber = document?.registryNumber ?? null;
  }
  return toGoodsReceiptDetail(created, extras, []);
}

/** afterJson de GOODS_RECEIPT_CREATED: identificadores e importes, nunca texto libre. */
export function goodsReceiptAuditSummary(detail: GoodsReceiptDetail): Record<string, unknown> {
  return {
    deliveryNoteNumber: detail.deliveryNoteNumber,
    deliveryDate: detail.deliveryDate,
    supplierId: detail.supplierId,
    supplierTaxId: detail.supplierTaxId,
    status: detail.status,
    lineCount: detail.lineCount,
    baseTotal: detail.baseTotal,
    stockMovements: detail.lines.filter((line) => line.stockMovementId !== null).length,
    incomingDocumentId: detail.incomingDocumentId
  };
}

// ---------------------------------------------------------------------------
// Comandos y consultas HTTP
// ---------------------------------------------------------------------------

type CommandInput = { context: UserContext; propertyId: string; correlationId: string };

export async function createGoodsReceipt(input: CommandInput & { body: unknown }): Promise<GoodsReceiptDetail> {
  requirePermissions(input.context, [GOODS_RECEIPT_MANAGE_PERMISSION]);
  const organizationId = await organizationOfProperty(prisma, input.propertyId);
  const detail = await prisma.$transaction((tx) =>
    createGoodsReceiptInTx(tx, { organizationId, propertyId: input.propertyId, receivedBy: input.context.userId, body: input.body })
  );
  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: GOODS_RECEIPT_AUDIT_ACTIONS.created,
    entityType: GOODS_RECEIPT_AUDIT_ENTITY,
    entityId: detail.id,
    afterJson: goodsReceiptAuditSummary(detail),
    ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
    correlationId: input.correlationId
  });
  return detail;
}

export type ListGoodsReceiptsInput = { propertyId: string; query: Record<string, unknown> };

/** Lista del centro por fecha de albarán descendente (cursor = día + id), con los filtros de GoodsReceiptFilters. */
export async function listGoodsReceipts(input: ListGoodsReceiptsInput): Promise<{ page: Page<GoodsReceiptRecord>; pageQuery: PageQuery }> {
  const filters = parseOr400(goodsReceiptListQuerySchema, input.query ?? {}, "Filtro");
  const pageQuery = parsePageQuery(input.query);
  const cursor = decodeCursor(pageQuery.cursor);
  const where: Prisma.GoodsReceiptWhereInput = {
    propertyId: input.propertyId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    ...(filters.from || filters.to
      ? { deliveryDate: { ...(filters.from ? { gte: new Date(`${filters.from}T00:00:00.000Z`) } : {}), ...(filters.to ? { lte: new Date(`${filters.to}T00:00:00.000Z`) } : {}) } }
      : {}),
    ...(filters.q ? { OR: [{ deliveryNoteNumber: { contains: filters.q, mode: "insensitive" } }, { note: { contains: filters.q, mode: "insensitive" } }, { supplierTaxId: { contains: filters.q, mode: "insensitive" } }] } : {})
  };
  const cursorWhere: Prisma.GoodsReceiptWhereInput | null = cursor
    ? { OR: [{ deliveryDate: { lt: new Date(`${cursor.k}T00:00:00.000Z`) } }, { deliveryDate: new Date(`${cursor.k}T00:00:00.000Z`), id: { lt: cursor.id } }] }
    : null;
  const [total, rows] = await Promise.all([
    prisma.goodsReceipt.count({ where }),
    prisma.goodsReceipt.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      include: { lines: true },
      orderBy: [{ deliveryDate: "desc" }, { id: "desc" }],
      take: pageQuery.limit + 1
    })
  ]);
  const extras = await extrasFor(prisma, rows);
  const records = rows.map((row) => toGoodsReceiptRecord(row, extras.get(row.id) ?? { supplierName: null, registryNumber: null }));
  return { page: buildPage(records, pageQuery.limit, total, (row) => row.deliveryDate), pageQuery };
}

export async function getGoodsReceipt(input: { propertyId: string; receiptId: string }): Promise<GoodsReceiptDetail> {
  const row = await requireReceipt(prisma, input.propertyId, input.receiptId);
  const [extras, matches] = await Promise.all([extrasFor(prisma, [row]), matchesOf(prisma, row.lines.map((line) => line.id))]);
  return toGoodsReceiptDetail(row, extras.get(row.id) ?? { supplierName: null, registryNumber: null }, matches);
}

export async function disputeGoodsReceipt(input: CommandInput & { receiptId: string; body: unknown }): Promise<GoodsReceiptDetail> {
  requirePermissions(input.context, [GOODS_RECEIPT_MANAGE_PERMISSION]);
  const data = parseOr400(goodsReceiptDisputeSchema, input.body ?? {}, "Disputa");
  const before = await requireReceipt(prisma, input.propertyId, input.receiptId);
  const transition = disputeTransition(before.status as GoodsReceiptStatus);
  if (!transition.ok) throw typed(409, "INVALID_STATUS_TRANSITION", transition.reason, { status: before.status });
  const row = await prisma.goodsReceipt.update({
    where: { id: before.id },
    data: { status: transition.next, note: noteWithDispute(before.note, data.reason) },
    include: { lines: true }
  });
  const [extras, matches] = await Promise.all([extrasFor(prisma, [row]), matchesOf(prisma, row.lines.map((line) => line.id))]);
  const detail = toGoodsReceiptDetail(row, extras.get(row.id) ?? { supplierName: null, registryNumber: null }, matches);
  recordAuditEvent({
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: GOODS_RECEIPT_AUDIT_ACTIONS.disputed,
    entityType: GOODS_RECEIPT_AUDIT_ENTITY,
    entityId: row.id,
    beforeJson: { status: before.status },
    afterJson: { status: row.status, reason: data.reason, deliveryNoteNumber: row.deliveryNoteNumber },
    ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
    correlationId: input.correlationId
  });
  return detail;
}
