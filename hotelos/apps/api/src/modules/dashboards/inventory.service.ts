import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

// Read-only inventory health monitor: stock levels, low-stock alerts,
// consumption velocity and recent movement trail for a property.
//
// Sharp edges to be aware of (see report):
//   * `InventoryItem.minLevel` is nullable Decimal — items without a min are
//     never flagged below-min. We treat null as "no minimum" by skipping.
//   * `StockMovement` is the source of truth for current quantity (the schema
//     has no per-item denormalised `currentQty`). We compute current quantity
//     from the sum of signed quantities (movement_type drives the sign).
//   * `unitCost` is per-movement and nullable. For inventory valuation we
//     use the weighted-average cost across in-flow movements per item; if no
//     positive cost ever recorded for an item we value it at 0.
//   * `InventoryDay` and `InventoryResource` are unrelated to physical stock
//     (they model room-night availability and bookable resources). They are
//     intentionally not used in calculations even though the brief lists
//     them — wiring them in would conflate room inventory with stock.

export type InventoryDashboardInput = {
  propertyId: string;
  limit?: number;
};

export type InventoryDashboardKpis = {
  itemsCount: number;
  itemsBelowMin: number;
  lowStockValueEur: number;
  totalInventoryValueEur: number;
  movementsLast30d: number;
};

export type InventoryDashboardResult = {
  kpis: InventoryDashboardKpis;
  itemsBelowMinList: Array<{
    id: string;
    sku?: string;
    name: string;
    currentQty: number;
    minimumQty: number;
    locationName?: string;
  }>;
  topConsumed: Array<{ id: string; name: string; consumedQty: number }>;
  stockByLocation: Array<{ locationName: string; itemsCount: number; valueEur: number }>;
  recentMovements: Array<{
    id: string;
    itemName: string;
    movementType: string;
    quantity: number;
    at: string;
    locationName?: string;
  }>;
};

// Movement types that add stock (sign = +1). Anything else is treated as
// outbound (sign = -1). We keep this list explicit so an unknown type does
// not silently inflate quantities.
const INBOUND_TYPES = new Set(["receipt", "in", "purchase", "transfer_in", "adjustment_in", "return"]);
const CONSUMPTION_TYPES = new Set(["consumption", "out", "issue", "transfer_out", "adjustment_out", "loss", "waste"]);

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function safeNumber(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function signedQty(movementType: string, quantity: number): number {
  if (INBOUND_TYPES.has(movementType)) return quantity;
  if (CONSUMPTION_TYPES.has(movementType)) return -Math.abs(quantity);
  // Unknown movement types: respect the recorded sign of `quantity` itself.
  return quantity;
}

export async function buildInventoryDashboard(
  input: InventoryDashboardInput
): Promise<InventoryDashboardResult> {
  const propertyId = input.propertyId;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Pagination guard rails. Default 100, caller may override within [1, 500].
  const rawLimit = input.limit;
  const take = Number.isFinite(rawLimit as number)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit as number)))
    : 100;

  // Items, locations, movements (the three primary collections we need).
  const [items, locations, movements] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { propertyId, active: true },
      select: { id: true, sku: true, name: true, unit: true, minLevel: true },
      take
    }),
    prisma.stockLocation.findMany({
      where: { propertyId, active: true },
      select: { id: true, name: true },
      take
    }),
    prisma.stockMovement.findMany({
      where: { propertyId },
      select: {
        id: true,
        inventoryItemId: true,
        stockLocationId: true,
        movementType: true,
        quantity: true,
        unitCost: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" },
      take
    })
  ]);

  const itemById = new Map(items.map((it) => [it.id, it]));
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));

  // ---- Aggregations across all movements ----
  // Per-item current qty and weighted-avg cost.
  // Per-item primary location (most recent movement location).
  // Per-(item, location) qty for stockByLocation.
  // Per-item 30-day consumption.
  const qtyByItem = new Map<string, number>();
  const inboundQtyByItem = new Map<string, number>();
  const inboundCostByItem = new Map<string, number>();
  const lastLocationByItem = new Map<string, string>();
  const qtyByItemLocation = new Map<string, number>(); // key = `${itemId}::${locId}`
  const consumedByItem = new Map<string, number>();
  let movementsLast30d = 0;

  for (const mv of movements) {
    const qty = dec(mv.quantity);
    const cost = dec(mv.unitCost);
    const itemId = mv.inventoryItemId;
    const locId = mv.stockLocationId;
    const signed = signedQty(mv.movementType, qty);

    qtyByItem.set(itemId, (qtyByItem.get(itemId) ?? 0) + signed);

    const key = `${itemId}::${locId}`;
    qtyByItemLocation.set(key, (qtyByItemLocation.get(key) ?? 0) + signed);

    if (!lastLocationByItem.has(itemId)) {
      // movements are sorted desc, so the first one we see per item is the latest.
      lastLocationByItem.set(itemId, locId);
    }

    if (INBOUND_TYPES.has(mv.movementType) && cost > 0 && qty > 0) {
      inboundQtyByItem.set(itemId, (inboundQtyByItem.get(itemId) ?? 0) + qty);
      inboundCostByItem.set(itemId, (inboundCostByItem.get(itemId) ?? 0) + qty * cost);
    }

    if (mv.createdAt >= thirtyDaysAgo) {
      movementsLast30d += 1;
      if (CONSUMPTION_TYPES.has(mv.movementType)) {
        consumedByItem.set(itemId, (consumedByItem.get(itemId) ?? 0) + Math.abs(qty));
      }
    }
  }

  // Average unit cost per item (weighted by inbound qty). 0 if no inbound history.
  function avgCost(itemId: string): number {
    const totalQty = inboundQtyByItem.get(itemId) ?? 0;
    if (totalQty <= 0) return 0;
    const totalCost = inboundCostByItem.get(itemId) ?? 0;
    return totalCost / totalQty;
  }

  // ---- KPIs ----
  const itemsCount = items.length;
  let itemsBelowMin = 0;
  let lowStockValueEur = 0;
  let totalInventoryValueEur = 0;

  const itemsBelowMinList: InventoryDashboardResult["itemsBelowMinList"] = [];

  for (const item of items) {
    const current = qtyByItem.get(item.id) ?? 0;
    const min = item.minLevel === null || item.minLevel === undefined ? null : dec(item.minLevel);
    const cost = avgCost(item.id);
    const value = Math.max(0, current) * cost;
    totalInventoryValueEur += value;

    if (min !== null && current < min) {
      itemsBelowMin += 1;
      lowStockValueEur += value;
      const locId = lastLocationByItem.get(item.id);
      const locationName = locId ? locationById.get(locId)?.name : undefined;
      itemsBelowMinList.push({
        id: item.id,
        sku: item.sku ?? undefined,
        name: item.name,
        currentQty: round2(current),
        minimumQty: round2(min),
        locationName
      });
    }
  }

  itemsBelowMinList.sort((a, b) => {
    const da = a.minimumQty - a.currentQty;
    const db = b.minimumQty - b.currentQty;
    return db - da;
  });

  // ---- topConsumed (last 30 days) ----
  const topConsumed = Array.from(consumedByItem.entries())
    .map(([id, consumedQty]) => ({
      id,
      name: itemById.get(id)?.name ?? id,
      consumedQty: round2(consumedQty)
    }))
    .filter((row) => row.consumedQty > 0)
    .sort((a, b) => b.consumedQty - a.consumedQty)
    .slice(0, 10);

  // ---- stockByLocation ----
  // Aggregate per location: distinct item count with positive qty, total EUR value.
  const locationAgg = new Map<string, { itemsCount: number; valueEur: number }>();
  for (const loc of locations) {
    locationAgg.set(loc.id, { itemsCount: 0, valueEur: 0 });
  }
  for (const [key, qty] of qtyByItemLocation) {
    const [itemId, locId] = key.split("::");
    if (!locationAgg.has(locId)) continue;
    if (qty <= 0) continue;
    const cost = avgCost(itemId);
    const entry = locationAgg.get(locId)!;
    entry.itemsCount += 1;
    entry.valueEur += qty * cost;
  }
  const stockByLocation = Array.from(locationAgg.entries())
    .map(([locId, agg]) => ({
      locationName: locationById.get(locId)?.name ?? locId,
      itemsCount: agg.itemsCount,
      valueEur: round2(agg.valueEur)
    }))
    .sort((a, b) => b.valueEur - a.valueEur);

  // ---- recentMovements (latest 20) ----
  const recentMovements = movements.slice(0, 20).map((mv) => ({
    id: mv.id,
    itemName: itemById.get(mv.inventoryItemId)?.name ?? mv.inventoryItemId,
    movementType: mv.movementType,
    quantity: round2(dec(mv.quantity)),
    at: mv.createdAt.toISOString(),
    locationName: locationById.get(mv.stockLocationId)?.name
  }));

  return {
    kpis: {
      itemsCount: safeNumber(itemsCount),
      itemsBelowMin: safeNumber(itemsBelowMin),
      lowStockValueEur: round2(safeNumber(lowStockValueEur)),
      totalInventoryValueEur: round2(safeNumber(totalInventoryValueEur)),
      movementsLast30d: safeNumber(movementsLast30d)
    },
    itemsBelowMinList,
    topConsumed,
    stockByLocation,
    recentMovements
  };
}
