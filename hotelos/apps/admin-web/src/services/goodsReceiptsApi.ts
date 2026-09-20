// Recepciones de mercancía y cotejo (Tanda T9 · lote T9-10, diseño
// docs/design/DOCUMENTOS-DIGITALIZACION.md §7.2 y §9). Cliente tipado de
// apps/api/src/modules/documents/goods-receipts.routes.ts y de la ruta de
// cotejo de payables sobre packages/shared/src/documents-types.ts (cantidades y
// precios como cadena decimal; `details.code` GOODS_RECEIPT_DUPLICATE ·
// SUPPLIER_BILL_MATCH_REQUIRED en los 409).
//
//   POST /properties/:propertyId/goods-receipts                          create             procurement.manage
//   GET  /properties/:propertyId/goods-receipts                          list (envelope)    accounting.read | inventory.read
//   GET  /properties/:propertyId/goods-receipts/:id                      get                idem
//   POST /properties/:propertyId/goods-receipts/:id/dispute              dispute            procurement.manage
//   POST /properties/:propertyId/payables/supplier-bills/:billId/match   matchSupplierBill  procurement.manage
//
// Estado del API (2026-09-19): las cinco rutas llegan con el lote de
// recepciones y cotejo (T9-11/T9-12); hasta entonces responden 404. Listas
// siempre con `envelope=1` (`{ items, nextCursor }`, lib/pagination.ts);
// `goodsReceiptListPath` / `goodsReceiptListQuery` para `useApiData`.
// Defaults: el centro activo (services/activeProperty.ts), como payablesApi.ts.

import type { DocumentListPage, GoodsReceiptDetail, GoodsReceiptDisputeRequest, GoodsReceiptFilters, GoodsReceiptRecord, GoodsReceiptRequest, SupplierBillMatchRequest, SupplierBillMatchResponse } from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { compactQuery, type FinanceQuery } from "./finance-contracts";

export type { GoodsReceiptDetail, GoodsReceiptFilters, GoodsReceiptRecord, GoodsReceiptRequest, SupplierBillMatchRequest, SupplierBillMatchResponse } from "@hotelos/shared";

const enc = encodeURIComponent;

export type GoodsReceiptListPage = DocumentListPage<GoodsReceiptRecord>;

export function goodsReceiptListPath(propertyId = getActivePropertyId()): string {
  return `/properties/${enc(propertyId)}/goods-receipts`;
}

/** Filtros de la lista de recepciones como query string; siempre `envelope=1`. */
export function goodsReceiptListQuery(filters: GoodsReceiptFilters = {}): FinanceQuery {
  return compactQuery({
    status: filters.status,
    supplierId: filters.supplierId,
    from: filters.from,
    to: filters.to,
    q: filters.q,
    cursor: filters.cursor,
    limit: filters.limit,
    envelope: "1"
  });
}

/** 201: alta manual de un albarán (sin documento) o desde la revisión; 409 GOODS_RECEIPT_DUPLICATE por (proveedor, nº de albarán). */
export function create(body: GoodsReceiptRequest, propertyId = getActivePropertyId()): Promise<GoodsReceiptDetail> {
  return apiRequest<GoodsReceiptDetail>(goodsReceiptListPath(propertyId), { method: "POST", body });
}

export function list(filters: GoodsReceiptFilters = {}, propertyId = getActivePropertyId()): Promise<GoodsReceiptListPage> {
  return apiRequest<GoodsReceiptListPage>(goodsReceiptListPath(propertyId), { query: goodsReceiptListQuery(filters) });
}

export function get(receiptId: string, propertyId = getActivePropertyId()): Promise<GoodsReceiptDetail> {
  return apiRequest<GoodsReceiptDetail>(`${goodsReceiptListPath(propertyId)}/${enc(receiptId)}`);
}

/** received | matched → disputed (motivo obligatorio). */
export function dispute(receiptId: string, body: GoodsReceiptDisputeRequest, propertyId = getActivePropertyId()): Promise<GoodsReceiptDetail> {
  return apiRequest<GoodsReceiptDetail>(`${goodsReceiptListPath(propertyId)}/${enc(receiptId)}/dispute`, { method: "POST", body });
}

/** Cotejo a 2 vías de una factura recibida con albaranes concretos o `auto` (mismo proveedor y centro) → `matches[]` y `matchStatus`. */
export function matchSupplierBill(billId: string, body: SupplierBillMatchRequest = { auto: true }, propertyId = getActivePropertyId()): Promise<SupplierBillMatchResponse> {
  return apiRequest<SupplierBillMatchResponse>(`/properties/${enc(propertyId)}/payables/supplier-bills/${enc(billId)}/match`, { method: "POST", body });
}

/** Superficie agrupada (`goodsReceiptsApi.create(…)`). */
export const goodsReceiptsApi = { create, list, get, dispute, matchSupplierBill } as const;
