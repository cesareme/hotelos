import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

// Read-only POS / F&B dashboard: outlet sales overview.
//
// Sharp edges to be aware of (see report):
//   * `PosOrder` has no direct `folioId` column. The only link to a folio is
//     transitive: PosOrder.reservationId -> Reservation -> Folio(reservationId).
//     We therefore compute folio attach rate as: % of PosOrders (in window) whose
//     `reservationId` is non-null AND that reservation has at least one Folio row.
//     A charge-to-room order without a Folio still counts as "not attached".
//   * `PosOrder.status` has no schema-level enum. We treat anything not equal to
//     "voided"/"cancelled" as a contributing sale for revenue / KPIs. Status is
//     surfaced verbatim in `recentOrders` for the UI to label.
//   * `PosProduct.outletId` is nullable, so `topProducts.outletName` is optional.
//   * `activeOutlets` counts distinct outlets that have at least one non-voided
//     PosOrder in the window (a "saw activity" definition). The schema also
//     carries `Outlet.status`, but it's a free-form string, so window activity
//     is the more reliable signal here.
//   * Defaults: if neither `from` nor `to` is passed, the window is the current
//     calendar month [startOfMonth(now), now]. Bounds are inclusive on `from`
//     and exclusive on `to`-as-now-plus-1ms behaviour is avoided by using
//     `lte` for the upper bound (so the latest order is included).

export type PosDashboardInput = {
  propertyId: string;
  from?: Date | string;
  to?: Date | string;
  limit?: number;
};

export type PosDashboardKpis = {
  revenueMtdEur: number;
  ordersMtd: number;
  averageTicketEur: number;
  activeOutlets: number;
  folioAttachRatePct: number;
};

export type PosDashboardResult = {
  kpis: PosDashboardKpis;
  revenueByOutlet: Array<{ outletName: string; ordersCount: number; revenueEur: number; avgTicketEur: number }>;
  topProducts: Array<{ id: string; name: string; outletName?: string; unitsSold: number; revenueEur: number }>;
  recentOrders: Array<{ id: string; outletName?: string; total: number; status: string; createdAt: string; itemCount: number }>;
};

const VOIDED_STATUSES = new Set(["voided", "cancelled", "canceled"]);

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function buildPosDashboard(input: PosDashboardInput): Promise<PosDashboardResult> {
  const propertyId = input.propertyId;
  const now = new Date();
  const from = parseDate(input.from) ?? startOfMonth(now);
  const to = parseDate(input.to) ?? now;

  // Pagination guard rails. Default 100, caller may override within [1, 500].
  const rawLimit = input.limit;
  const take = Number.isFinite(rawLimit as number)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit as number)))
    : 100;

  // 1) Load all PosOrders in window for the property + their lines, plus outlets
  //    (so we can label rows and count "active outlets").
  const [orderRows, outletRows] = await Promise.all([
    prisma.posOrder.findMany({
      where: {
        propertyId,
        createdAt: { gte: from, lte: to }
      },
      orderBy: { createdAt: "desc" },
      take
    }),
    prisma.outlet.findMany({ where: { propertyId }, take })
  ]);

  const outletById = new Map<string, { id: string; name: string }>();
  for (const outlet of outletRows) {
    outletById.set(outlet.id, { id: outlet.id, name: outlet.name });
  }

  // Non-voided orders are the "sales" universe for revenue, top products and outlet stats.
  const salesOrders = orderRows.filter((o) => !VOIDED_STATUSES.has(String(o.status).toLowerCase()));
  const salesOrderIds = salesOrders.map((o) => o.id);

  // 2) Load PosOrderLines for the sales orders so we can build top products + item counts.
  // Lines are bounded by the order set above × an additional generous ceiling so a
  // hotel chain with many lines per order does not blow up the dashboard.
  const lineRows = salesOrderIds.length
    ? await prisma.posOrderLine.findMany({
        where: { posOrderId: { in: salesOrderIds } },
        take: Math.max(take, 500)
      })
    : [];

  // Group lines by orderId to compute item counts and by productId for top products.
  const linesByOrder = new Map<string, typeof lineRows>();
  for (const line of lineRows) {
    const arr = linesByOrder.get(line.posOrderId);
    if (arr) arr.push(line);
    else linesByOrder.set(line.posOrderId, [line]);
  }

  // 3) KPIs.
  const revenueMtdEur = round(salesOrders.reduce((sum, o) => sum + dec(o.total), 0));
  const ordersMtd = salesOrders.length;
  const averageTicketEur = ordersMtd > 0 ? round(revenueMtdEur / ordersMtd) : 0;
  const activeOutletIds = new Set(salesOrders.map((o) => o.outletId));
  const activeOutlets = activeOutletIds.size;

  // Folio attach rate: % of sales orders whose reservation has at least one folio.
  // Counts non-voided orders only — voided orders are noise for this signal.
  const reservationIds = Array.from(
    new Set(salesOrders.map((o) => o.reservationId).filter((id): id is string => !!id))
  );
  const folioRows = reservationIds.length
    ? await prisma.folio.findMany({
        where: { reservationId: { in: reservationIds } },
        select: { reservationId: true },
        take: Math.max(take, 500)
      })
    : [];
  const reservationsWithFolio = new Set(folioRows.map((f) => f.reservationId));
  const attachedCount = salesOrders.filter((o) =>
    o.reservationId ? reservationsWithFolio.has(o.reservationId) : false
  ).length;
  const folioAttachRatePct = ordersMtd > 0
    ? Math.round((attachedCount / ordersMtd) * 1000) / 10
    : 0;

  // 4) Revenue by outlet.
  type OutletAgg = { outletId: string; outletName: string; ordersCount: number; revenueEur: number };
  const outletAgg = new Map<string, OutletAgg>();
  for (const order of salesOrders) {
    const outletName = outletById.get(order.outletId)?.name ?? "Unknown outlet";
    const existing = outletAgg.get(order.outletId);
    if (existing) {
      existing.ordersCount += 1;
      existing.revenueEur = round(existing.revenueEur + dec(order.total));
    } else {
      outletAgg.set(order.outletId, {
        outletId: order.outletId,
        outletName,
        ordersCount: 1,
        revenueEur: round(dec(order.total))
      });
    }
  }
  const revenueByOutlet = Array.from(outletAgg.values())
    .map((row) => ({
      outletName: row.outletName,
      ordersCount: row.ordersCount,
      revenueEur: round(row.revenueEur),
      avgTicketEur: row.ordersCount > 0 ? round(row.revenueEur / row.ordersCount) : 0
    }))
    .sort((a, b) => b.revenueEur - a.revenueEur);

  // 5) Top products — group lines by productId (skip lines without a product link).
  const productIds = Array.from(
    new Set(lineRows.map((l) => l.productId).filter((id): id is string => !!id))
  );
  const productRows = productIds.length
    ? await prisma.posProduct.findMany({
        where: { id: { in: productIds } },
        take: Math.max(take, 500)
      })
    : [];
  const productById = new Map<string, { id: string; name: string; outletId: string | null }>();
  for (const p of productRows) {
    productById.set(p.id, { id: p.id, name: p.name, outletId: p.outletId ?? null });
  }

  type ProductAgg = { id: string; name: string; outletName?: string; unitsSold: number; revenueEur: number };
  const productAgg = new Map<string, ProductAgg>();
  for (const line of lineRows) {
    if (!line.productId) continue;
    const product = productById.get(line.productId);
    if (!product) continue;
    const outletName = product.outletId ? outletById.get(product.outletId)?.name : undefined;
    const existing = productAgg.get(line.productId);
    const qty = dec(line.quantity);
    const lineTotal = dec(line.total);
    if (existing) {
      existing.unitsSold = round(existing.unitsSold + qty);
      existing.revenueEur = round(existing.revenueEur + lineTotal);
    } else {
      productAgg.set(line.productId, {
        id: product.id,
        name: product.name,
        outletName,
        unitsSold: round(qty),
        revenueEur: round(lineTotal)
      });
    }
  }
  const topProducts = Array.from(productAgg.values())
    .filter((p) => p.revenueEur > 0 || p.unitsSold > 0)
    .sort((a, b) => b.revenueEur - a.revenueEur)
    .slice(0, 10);

  // 6) Recent orders — last 10 PosOrders (including voided, so floor staff sees the trail).
  const recentOrders = orderRows.slice(0, 10).map((o) => {
    const outletName = outletById.get(o.outletId)?.name;
    const itemCount = (linesByOrder.get(o.id) ?? []).reduce((sum, l) => sum + dec(l.quantity), 0);
    return {
      id: o.id,
      outletName,
      total: round(dec(o.total)),
      status: String(o.status),
      createdAt: o.createdAt.toISOString(),
      itemCount: Math.round(itemCount)
    };
  });

  return {
    kpis: {
      revenueMtdEur,
      ordersMtd,
      averageTicketEur,
      activeOutlets,
      folioAttachRatePct
    },
    revenueByOutlet,
    topProducts,
    recentOrders
  };
}
