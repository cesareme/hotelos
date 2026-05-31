// F&B Inventory — bridges POS sales with the existing InventoryItem /
// StockLocation / StockMovement chain.
//
// Key responsibilities:
//   - InventoryItem CRUD + StockLocation CRUD
//   - Initial / opening stock movements (receipt-style)
//   - Current balance: sum of StockMovement.quantity per InventoryItem
//     (positive = receipt/return, negative = sale/waste)
//   - MenuItem + MenuRecipe CRUD (bill-of-materials for what POS sells)
//   - consumePosTicket(ticket): on POS close → for each line look up
//     MenuItem by outlet+name, apply recipes, emit StockMovements of
//     type "sale_consumption"
//   - listStockBalances + lowStockReport
import { prisma } from "@hotelos/database";
import { NotFoundError, BadRequestError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";

// -------------------- Stock locations --------------------

export async function listStockLocations(propertyId: string) {
  return prisma.stockLocation.findMany({ where: { propertyId, active: true }, orderBy: { name: "asc" } });
}

export async function createStockLocation(input: {
  context: UserContext;
  propertyId: string;
  payload: { name: string; locationType: string; roomId?: string; spaceId?: string };
}) {
  const p = input.payload;
  if (!p.name?.trim() || !p.locationType?.trim()) throw new BadRequestError("name y locationType son obligatorios.");
  return prisma.stockLocation.create({
    data: {
      propertyId: input.propertyId,
      name: p.name.trim(),
      locationType: p.locationType.trim(),
      roomId: p.roomId ?? null,
      spaceId: p.spaceId ?? null,
      active: true
    }
  });
}

// -------------------- Inventory items --------------------

export async function listInventoryItems(propertyId: string) {
  return prisma.inventoryItem.findMany({ where: { propertyId, active: true }, orderBy: [{ category: "asc" }, { name: "asc" }] });
}

export async function createInventoryItem(input: {
  context: UserContext;
  propertyId: string;
  payload: { sku?: string; name: string; category?: string; unit: string; defaultSupplierId?: string; minLevel?: number; maxLevel?: number; unitCost?: number };
}) {
  const p = input.payload;
  if (!p.name?.trim() || !p.unit?.trim()) throw new BadRequestError("name y unit son obligatorios.");
  return prisma.inventoryItem.create({
    data: {
      propertyId: input.propertyId,
      sku: p.sku ?? null,
      name: p.name.trim(),
      category: p.category ?? null,
      unit: p.unit.trim(),
      defaultSupplierId: p.defaultSupplierId ?? null,
      minLevel: p.minLevel ?? null,
      maxLevel: p.maxLevel ?? null,
      unitCost: p.unitCost ?? null,
      active: true
    }
  });
}

// -------------------- Stock movements --------------------

export async function recordStockMovement(input: {
  propertyId: string;
  inventoryItemId: string;
  stockLocationId: string;
  movementType: "opening_balance" | "receipt" | "sale_consumption" | "waste" | "adjustment" | "transfer_in" | "transfer_out";
  quantity: number; // positive = increase, negative = decrease
  unitCost?: number;
  sourceType?: string;
  sourceId?: string;
}) {
  if (!Number.isFinite(input.quantity) || input.quantity === 0) throw new BadRequestError("quantity debe ser un número distinto de cero.");
  return prisma.stockMovement.create({
    data: {
      propertyId: input.propertyId,
      inventoryItemId: input.inventoryItemId,
      stockLocationId: input.stockLocationId,
      movementType: input.movementType,
      quantity: input.quantity,
      unitCost: input.unitCost ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null
    }
  });
}

// -------------------- Current balances --------------------

export type StockBalanceRow = {
  inventoryItemId: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit: string;
  minLevel: number | null;
  maxLevel: number | null;
  onHand: number;
  lowStock: boolean;
};

export async function listStockBalances(propertyId: string): Promise<StockBalanceRow[]> {
  const items = await prisma.inventoryItem.findMany({ where: { propertyId, active: true } });
  // SUM(quantity) per inventoryItemId
  const grouped = await prisma.stockMovement.groupBy({
    by: ["inventoryItemId"],
    where: { propertyId },
    _sum: { quantity: true }
  });
  const balanceByItem = new Map<string, number>();
  for (const row of grouped) {
    balanceByItem.set(row.inventoryItemId, Number(row._sum.quantity?.toString() ?? "0"));
  }
  return items.map((i) => {
    const onHand = balanceByItem.get(i.id) ?? 0;
    const min = i.minLevel ? Number(i.minLevel.toString()) : null;
    return {
      inventoryItemId: i.id, name: i.name, sku: i.sku, category: i.category, unit: i.unit,
      minLevel: min, maxLevel: i.maxLevel ? Number(i.maxLevel.toString()) : null,
      onHand,
      lowStock: min != null && onHand <= min
    };
  }).sort((a, b) => (a.lowStock === b.lowStock ? a.name.localeCompare(b.name) : a.lowStock ? -1 : 1));
}

export async function lowStockReport(propertyId: string) {
  const balances = await listStockBalances(propertyId);
  const items = balances.filter((b) => b.lowStock);
  return { count: items.length, items };
}

// -------------------- Menu items + recipes --------------------

export async function listMenuItems(propertyId: string, outletId?: string) {
  return prisma.menuItem.findMany({
    where: { propertyId, active: true, ...(outletId ? { outletId } : {}) },
    orderBy: [{ outletId: "asc" }, { category: "asc" }, { name: "asc" }]
  });
}

export async function getMenuItemWithRecipe(menuItemId: string) {
  const item = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
  if (!item) throw new NotFoundError("MenuItem no encontrado.");
  const recipes = await prisma.menuRecipe.findMany({ where: { menuItemId }, orderBy: { createdAt: "asc" } });
  return { ...item, recipes };
}

export async function createMenuItem(input: {
  context: UserContext;
  propertyId: string;
  payload: { outletId: string; sku?: string; name: string; category?: string; price: number; taxRate?: number };
}) {
  const p = input.payload;
  if (!p.name?.trim() || !p.outletId?.trim()) throw new BadRequestError("name y outletId son obligatorios.");
  if (!Number.isFinite(p.price) || p.price < 0) throw new BadRequestError("price debe ser ≥ 0.");
  return prisma.menuItem.create({
    data: {
      propertyId: input.propertyId,
      outletId: p.outletId.trim(),
      sku: p.sku ?? null,
      name: p.name.trim(),
      category: p.category ?? null,
      price: p.price,
      taxRate: p.taxRate ?? null,
      active: true
    }
  });
}

export async function addMenuRecipe(input: {
  context: UserContext;
  menuItemId: string;
  payload: { inventoryItemId: string; quantity: number; notes?: string };
}) {
  const p = input.payload;
  if (!p.inventoryItemId || !Number.isFinite(p.quantity) || p.quantity <= 0) {
    throw new BadRequestError("inventoryItemId y quantity (> 0) son obligatorios.");
  }
  const menu = await prisma.menuItem.findUnique({ where: { id: input.menuItemId } });
  if (!menu) throw new NotFoundError("MenuItem no encontrado.");
  const inv = await prisma.inventoryItem.findUnique({ where: { id: p.inventoryItemId } });
  if (!inv) throw new NotFoundError("InventoryItem no encontrado.");
  return prisma.menuRecipe.create({
    data: { menuItemId: input.menuItemId, inventoryItemId: p.inventoryItemId, quantity: p.quantity, notes: p.notes ?? null }
  });
}

export async function deleteMenuRecipe(id: string) {
  const existing = await prisma.menuRecipe.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("MenuRecipe no encontrada.");
  await prisma.menuRecipe.delete({ where: { id } });
  return { ok: true, id };
}

// -------------------- POS consumption --------------------

export type ConsumptionResult = {
  ticketId: string;
  matchedLines: number;
  unmatchedLines: number;
  movements: number;
  details: Array<{ lineName: string; matched: boolean; menuItemId?: string; consumed?: Array<{ inventoryItemId: string; itemName: string; quantity: number; unit: string }> }>;
};

// Called by pos.service.closePosTicket. Tries to match each ticket line to a
// MenuItem in the same outlet (case-insensitive) and applies its recipe.
// Lines without a MenuItem match are reported as `unmatched` — the ticket
// still closes, but inventory does not move (typical for free-text consumos).
export async function consumeStockForPosTicket(input: {
  propertyId: string;
  ticketId: string;
  outletId: string;
  lines: Array<{ name: string; quantity: number }>;
}): Promise<ConsumptionResult> {
  const menuItems = await prisma.menuItem.findMany({
    where: { propertyId: input.propertyId, outletId: input.outletId, active: true }
  });
  const recipesByMenu = new Map<string, Array<{ inventoryItemId: string; quantity: number }>>();
  if (menuItems.length > 0) {
    const recipes = await prisma.menuRecipe.findMany({ where: { menuItemId: { in: menuItems.map((m) => m.id) } } });
    for (const r of recipes) {
      const arr = recipesByMenu.get(r.menuItemId) ?? [];
      arr.push({ inventoryItemId: r.inventoryItemId, quantity: Number(r.quantity.toString()) });
      recipesByMenu.set(r.menuItemId, arr);
    }
  }
  const menuByName = new Map(menuItems.map((m) => [m.name.toLowerCase(), m]));

  // Default location: first stock location for the property
  const defaultLocation = await prisma.stockLocation.findFirst({ where: { propertyId: input.propertyId, active: true } });

  const details: ConsumptionResult["details"] = [];
  let matched = 0;
  let unmatched = 0;
  let movements = 0;

  for (const line of input.lines) {
    const menu = menuByName.get(line.name.toLowerCase().trim());
    if (!menu) {
      unmatched += 1;
      details.push({ lineName: line.name, matched: false });
      continue;
    }
    matched += 1;
    const recipe = recipesByMenu.get(menu.id) ?? [];
    if (recipe.length === 0 || !defaultLocation) {
      details.push({ lineName: line.name, matched: true, menuItemId: menu.id, consumed: [] });
      continue;
    }
    const consumed: Array<{ inventoryItemId: string; itemName: string; quantity: number; unit: string }> = [];
    for (const r of recipe) {
      const totalQty = r.quantity * line.quantity;
      const inv = await prisma.inventoryItem.findUnique({ where: { id: r.inventoryItemId } });
      if (!inv) continue;
      await recordStockMovement({
        propertyId: input.propertyId,
        inventoryItemId: r.inventoryItemId,
        stockLocationId: defaultLocation.id,
        movementType: "sale_consumption",
        quantity: -totalQty,
        sourceType: "pos_ticket",
        sourceId: input.ticketId
      });
      movements += 1;
      consumed.push({ inventoryItemId: r.inventoryItemId, itemName: inv.name, quantity: totalQty, unit: inv.unit });
    }
    details.push({ lineName: line.name, matched: true, menuItemId: menu.id, consumed });
  }
  return { ticketId: input.ticketId, matchedLines: matched, unmatchedLines: unmatched, movements, details };
}
