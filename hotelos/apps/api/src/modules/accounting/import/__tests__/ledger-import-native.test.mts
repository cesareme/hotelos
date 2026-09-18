// Tanda 7c · L6 (integrador): índice de documentos nativos para el modo sombra (ledger-import.native.ts).
//
// Hallazgo de la demo (2026-09-17): el cobro TPV `payment/<id>` de 12,50 € de Rías Altas del 12/07/2026 no
// tiene `invoiceId` (cobro del folio antes de facturar) y la proyección lo contabiliza igual; el índice solo
// tomaba los cobros ligados a una factura, así que el asiento de cobro de Sage se importaba y duplicaba el
// nativo (reconciliación 2026 con ±12,50 en 4300 / 5721). Estos tests pinan el filtro de la proyección
// (`paymentCandidates`: deletedAt null, reversalOfId null, status captured | refunded) y las devoluciones.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { buildNativeIndex, NATIVE_PAYMENT_STATUSES, NATIVE_REFUND_SOURCE_TYPE, type NativeIndexClient } from "../ledger-import.native.js";

type Where = Record<string, unknown>;

function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

/** Doble mínimo del cliente Prisma: aplica los filtros que usa el índice sobre listas en memoria. */
function clientDouble(input: {
  properties: Array<{ id: string; code: string | null }>;
  invoices: Array<{ id: string; invoiceNumber: string | null; seriesCode: string | null; propertyId: string; status: string; deletedAt: Date | null }>;
  payments: Array<{ id: string; propertyId: string; amount: Prisma.Decimal; invoiceId: string | null; createdAt: Date; status: string; deletedAt: Date | null; reversalOfId: string | null }>;
  refunds?: Array<{ id: string; paymentId: string; amount: Prisma.Decimal; createdAt: Date; status: string }>;
  entries?: Array<{ sourceType: string; sourceId: string; status: string }>;
}): NativeIndexClient & { calls: Where[] } {
  const calls: Where[] = [];
  const inList = (value: unknown, list: unknown): boolean => !list || (typeof list === "object" && list !== null && "in" in list ? (list as { in: unknown[] }).in.includes(value) : value === list);
  return {
    calls,
    property: { findMany: async () => input.properties },
    invoice: { findMany: async () => input.invoices.filter((row) => row.invoiceNumber !== null && row.deletedAt === null) },
    journalEntry: { findMany: async () => input.entries ?? [] },
    payment: {
      findMany: async (args: { where: Where }) => {
        calls.push(args.where);
        const where = args.where;
        return input.payments.filter((row) => inList(row.propertyId, where.propertyId) && (where.deletedAt === undefined || row.deletedAt === where.deletedAt) && (where.reversalOfId === undefined || row.reversalOfId === where.reversalOfId) && inList(row.status, where.status) && (where.invoiceId === undefined || inList(row.invoiceId, where.invoiceId)));
      }
    },
    paymentRefund: {
      findMany: async (args: { where: Where }) => (input.refunds ?? []).filter((row) => inList(row.paymentId, args.where.paymentId) && (args.where.status === undefined || row.status === args.where.status))
    }
  } as unknown as NativeIndexClient & { calls: Where[] };
}

const PROPERTY = "prop_ra";
const ORG = "org_native";

describe("buildNativeIndex · cobros nativos (modo sombra, §5.1)", () => {
  it("indexa un cobro captado SIN factura (cobro del folio antes de facturar) por importe y fecha", async () => {
    const client = clientDouble({
      properties: [{ id: PROPERTY, code: "RA" }],
      invoices: [],
      payments: [{ id: "pay_tpv", propertyId: PROPERTY, amount: decimal("12.50"), invoiceId: null, createdAt: new Date("2026-07-12T10:00:00Z"), status: "captured", deletedAt: null, reversalOfId: null }]
    });
    const { index, stats } = await buildNativeIndex(client, ORG);
    const refs = index.paymentAmounts.get("12.50") ?? [];
    assert.equal(refs.length, 1, "el cobro sin factura debe estar en el índice");
    // `propertyId` = centro del cobro: la heurística importe + fecha solo excluye asientos de Sage del mismo centro.
    assert.deepEqual(refs[0], { invoiceId: null, invoiceNumber: null, sourceType: "payment", sourceId: "pay_tpv", date: "2026-07-12", propertyId: PROPERTY });
    assert.equal(stats.payments, 1);
    // El filtro es el de la proyección: nunca por invoiceId.
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]!.invoiceId, undefined, "el índice no filtra por invoiceId");
    assert.equal(client.calls[0]!.reversalOfId, null);
    assert.deepEqual(client.calls[0]!.status, { in: [...NATIVE_PAYMENT_STATUSES] });
  });

  it("conserva el número de factura cuando el cobro sí está ligado a una factura", async () => {
    const client = clientDouble({
      properties: [{ id: PROPERTY, code: "RA" }],
      invoices: [{ id: "inv_1", invoiceNumber: "FAC-2026-000015", seriesCode: "FAC-2026", propertyId: PROPERTY, status: "issued", deletedAt: null }],
      payments: [{ id: "pay_1", propertyId: PROPERTY, amount: decimal("100.00"), invoiceId: "inv_1", createdAt: new Date("2026-07-20T00:00:00Z"), status: "captured", deletedAt: null, reversalOfId: null }],
      entries: [{ sourceType: "invoice", sourceId: "inv_1", status: "posted" }]
    });
    const { index } = await buildNativeIndex(client, ORG);
    assert.equal(index.paymentAmounts.get("100.00")?.[0]?.invoiceNumber, "FAC-2026-000015");
    assert.ok(index.invoiceKeys.has("FAC2026:15"), "clave de la factura por número impreso");
  });

  it("deja fuera los cobros pendientes, fallidos, borrados y las filas de reverso (no tienen asiento nativo)", async () => {
    const client = clientDouble({
      properties: [{ id: PROPERTY, code: "RA" }],
      invoices: [],
      payments: [
        { id: "pay_pending", propertyId: PROPERTY, amount: decimal("50.00"), invoiceId: null, createdAt: new Date("2026-07-01T00:00:00Z"), status: "pending", deletedAt: null, reversalOfId: null },
        { id: "pay_failed", propertyId: PROPERTY, amount: decimal("50.00"), invoiceId: null, createdAt: new Date("2026-07-01T00:00:00Z"), status: "failed", deletedAt: null, reversalOfId: null },
        { id: "pay_deleted", propertyId: PROPERTY, amount: decimal("50.00"), invoiceId: null, createdAt: new Date("2026-07-01T00:00:00Z"), status: "captured", deletedAt: new Date("2026-07-02T00:00:00Z"), reversalOfId: null },
        { id: "pay_reversal_row", propertyId: PROPERTY, amount: decimal("50.00"), invoiceId: null, createdAt: new Date("2026-07-01T00:00:00Z"), status: "refunded", deletedAt: null, reversalOfId: "pay_x" },
        { id: "pay_other_org", propertyId: "prop_other", amount: decimal("50.00"), invoiceId: null, createdAt: new Date("2026-07-01T00:00:00Z"), status: "captured", deletedAt: null, reversalOfId: null }
      ]
    });
    const { index, stats } = await buildNativeIndex(client, ORG);
    assert.equal(index.paymentAmounts.size, 0);
    assert.equal(stats.payments, 0);
  });

  it("indexa las devoluciones completadas como payment_refund con su propio importe y fecha", async () => {
    const client = clientDouble({
      properties: [{ id: PROPERTY, code: "RA" }],
      invoices: [{ id: "inv_2", invoiceNumber: "FAC-2026-000020", seriesCode: null, propertyId: PROPERTY, status: "issued", deletedAt: null }],
      payments: [{ id: "pay_2", propertyId: PROPERTY, amount: decimal("60.00"), invoiceId: "inv_2", createdAt: new Date("2026-07-10T00:00:00Z"), status: "refunded", deletedAt: null, reversalOfId: null }],
      refunds: [
        { id: "ref_ok", paymentId: "pay_2", amount: decimal("60.00"), createdAt: new Date("2026-07-15T00:00:00Z"), status: "completed" },
        { id: "ref_pending", paymentId: "pay_2", amount: decimal("60.00"), createdAt: new Date("2026-07-16T00:00:00Z"), status: "pending" }
      ]
    });
    const { index, stats } = await buildNativeIndex(client, ORG);
    const refs = index.paymentAmounts.get("60.00") ?? [];
    assert.equal(refs.length, 2, "cobro + devolución completada");
    assert.deepEqual(refs.map((ref) => ref.sourceType), ["payment", NATIVE_REFUND_SOURCE_TYPE]);
    assert.equal(refs[1]!.sourceId, "ref_ok");
    assert.equal(refs[1]!.date, "2026-07-15");
    assert.equal(refs[1]!.invoiceNumber, "FAC-2026-000020");
    assert.equal(stats.payments, 2);
  });

  it("sin cliente de devoluciones (dobles de otros tests) el índice sigue funcionando", async () => {
    const client = clientDouble({ properties: [{ id: PROPERTY, code: "RA" }], invoices: [], payments: [{ id: "pay_3", propertyId: PROPERTY, amount: decimal("10.00"), invoiceId: null, createdAt: new Date("2026-07-01T00:00:00Z"), status: "captured", deletedAt: null, reversalOfId: null }] });
    delete (client as unknown as { paymentRefund?: unknown }).paymentRefund;
    const { index } = await buildNativeIndex(client, ORG);
    assert.equal(index.paymentAmounts.get("10.00")?.length, 1);
  });
});
