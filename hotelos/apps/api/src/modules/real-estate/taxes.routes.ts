// Activo inmobiliario · rutas de tributos locales (Tanda ACT · L2): IBI / IAE /
// tasas, recibos, calendario y asiento 631 propuesto en borrador, bajo
// /properties/:propertyId/real-estate/*.
//
// Registradas desde real-estate.register.ts (`registerRealEstateRoutes`, que
// llama server.ts); permisos en taxes-route-permissions.partial.ts
// (real_estate.read para GET, property_tax.manage para escrituras; la propuesta
// de asiento es `critical`). La guardia global de tenencia de server.ts
// (pickPropertyId → grantPropertyAccess) cubre el :propertyId; el servicio
// busca cada tributo y recibo a través del centro (`tax.propertyId`) y responde
// 404 opaco. Patrón: core.routes.ts (L1).

import type { FastifyInstance } from "fastify";
import { createId } from "../../lib/ids.js";
import {
  createPropertyTax,
  createPropertyTaxReceipt,
  generatePropertyTaxReceipts,
  getPropertyTaxCalendar,
  listPropertyTaxReceipts,
  listPropertyTaxes,
  proposeReceiptEntry,
  updatePropertyTax,
  updatePropertyTaxReceipt
} from "./property-tax.service.js";

type PropertyParams = { propertyId: string };
type TaxParams = PropertyParams & { taxId: string };
type ReceiptParams = PropertyParams & { receiptId: string };

export function registerRealEstateTaxRoutes(app: FastifyInstance): void {
  // ── Tributos ──────────────────────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/taxes", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listPropertyTaxes(propertyId, request.query);
  });

  app.post("/properties/:propertyId/real-estate/taxes", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const tax = await createPropertyTax({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(tax);
  });

  app.patch("/properties/:propertyId/real-estate/taxes/:taxId", async (request) => {
    const params = request.params as TaxParams;
    return updatePropertyTax({ context: request.userContext, propertyId: params.propertyId, taxId: params.taxId, body: request.body, correlationId: createId("corr") });
  });

  // ── Recibos ───────────────────────────────────────────────────────────────
  app.post("/properties/:propertyId/real-estate/taxes/:taxId/receipts", async (request, reply) => {
    const params = request.params as TaxParams;
    const receipt = await createPropertyTaxReceipt({ context: request.userContext, propertyId: params.propertyId, taxId: params.taxId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(receipt);
  });

  app.post("/properties/:propertyId/real-estate/taxes/:taxId/receipts/generate", async (request, reply) => {
    const params = request.params as TaxParams;
    const result = await generatePropertyTaxReceipts({ context: request.userContext, propertyId: params.propertyId, taxId: params.taxId, body: request.body, correlationId: createId("corr") });
    // 201 solo cuando ha creado algún previsto; la repetición idempotente responde 200.
    return reply.code(result.created.length > 0 ? 201 : 200).send(result);
  });

  app.get("/properties/:propertyId/real-estate/receipts", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listPropertyTaxReceipts(propertyId, request.query);
  });

  app.patch("/properties/:propertyId/real-estate/receipts/:receiptId", async (request) => {
    const params = request.params as ReceiptParams;
    return updatePropertyTaxReceipt({ context: request.userContext, propertyId: params.propertyId, receiptId: params.receiptId, body: request.body, correlationId: createId("corr") });
  });

  // ── Asiento propuesto (borrador; lo contabiliza el contable con POST /journal-entries/:id/post) ──
  app.post("/properties/:propertyId/real-estate/receipts/:receiptId/propose-entry", async (request, reply) => {
    const params = request.params as ReceiptParams;
    const receipt = await proposeReceiptEntry({ context: request.userContext, propertyId: params.propertyId, receiptId: params.receiptId, correlationId: createId("corr") });
    return reply.code(201).send(receipt);
  });

  // ── Calendario del ejercicio ──────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/tax-calendar", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return getPropertyTaxCalendar(propertyId, request.query);
  });
}
