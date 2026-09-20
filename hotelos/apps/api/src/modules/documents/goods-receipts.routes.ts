// Documentos · rutas de recepciones de mercancía (Tanda T9 · lote T9-09,
// diseño §9 fila goods-receipts): alta manual sin documento, lista, detalle y
// disputa bajo /properties/:propertyId/goods-receipts.
//
// Registrado desde payables.routes.ts (`registerGoodsReceiptRoutes(app)` dentro
// de registerPayablesRoutes): las filas del manifiesto viven en
// modules/payables/route-permissions.partial.ts (el contrato raíz
// api-route-permissions-contract descubre este *.routes.ts y exige una fila por
// ruta en cualquier partial). Claves: procurement.manage (alta, disputa) e
// inventory.read (lecturas; el diseño dice «accounting.read | inventory.read»
// pero el manifiesto es una conjunción, así que va la clave de inventario).
//
// Tenencia: el hook global valida /properties/:propertyId; las rutas por id
// pasan además por assertEntityAccess({ entity: "goodsReceipt", propertyId })
// (lib/tenancy.ts, 404 opaco fuera del centro) y el servicio recomprueba el
// centro al cargar la fila.

import type { FastifyInstance } from "fastify";
import { createId } from "../../lib/ids.js";
import { pageBody, pageHeaders } from "../../lib/pagination.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { createGoodsReceipt, disputeGoodsReceipt, getGoodsReceipt, listGoodsReceipts } from "./goods-receipts.service.js";

type PropertyParams = { propertyId: string };
type ReceiptParams = PropertyParams & { id: string };

export function registerGoodsReceiptRoutes(app: FastifyInstance): void {
  app.post("/properties/:propertyId/goods-receipts", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const detail = await createGoodsReceipt({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(detail);
  });

  app.get("/properties/:propertyId/goods-receipts", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const { page, pageQuery } = await listGoodsReceipts({ propertyId, query: (request.query ?? {}) as Record<string, unknown> });
    reply.headers(pageHeaders(page));
    return pageBody(page, pageQuery);
  });

  app.get("/properties/:propertyId/goods-receipts/:id", async (request) => {
    const { propertyId, id } = request.params as ReceiptParams;
    await assertEntityAccess(request, { entity: "goodsReceipt", id, propertyId });
    return getGoodsReceipt({ propertyId, receiptId: id });
  });

  app.post("/properties/:propertyId/goods-receipts/:id/dispute", async (request) => {
    const { propertyId, id } = request.params as ReceiptParams;
    await assertEntityAccess(request, { entity: "goodsReceipt", id, propertyId });
    return disputeGoodsReceipt({ context: request.userContext, propertyId, receiptId: id, body: request.body, correlationId: createId("corr") });
  });
}
