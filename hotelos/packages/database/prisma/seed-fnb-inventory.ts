// Seed F&B inventory: stock location + canonical items (vinos, café, leche,
// patatas, aceite, queso, pan, agua) + 5 menu items con recetas + initial
// opening balances. Permits end-to-end testing of POS → stock consumption.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PID = process.env.SEED_PROPERTY_ID ?? "prop_123";

const ITEMS = [
  { sku: "VINO-RIOJA", name: "Vino Rioja Reserva (botella 75 cl)", category: "Vinos", unit: "botella", minLevel: 12, unitCost: 7.5 },
  { sku: "VINO-RUEDA", name: "Vino Rueda blanco (botella 75 cl)", category: "Vinos", unit: "botella", minLevel: 8, unitCost: 6.2 },
  { sku: "CAFE-MOL", name: "Café molido", category: "Cafetería", unit: "kg", minLevel: 2, unitCost: 14.0 },
  { sku: "LECHE-UHT", name: "Leche entera UHT", category: "Cafetería", unit: "L", minLevel: 10, unitCost: 0.85 },
  { sku: "QUESO-MANCHEGO", name: "Queso manchego curado", category: "Charcutería", unit: "kg", minLevel: 1, unitCost: 18.0 },
  { sku: "PATATAS", name: "Patatas frescas", category: "Cocina", unit: "kg", minLevel: 5, unitCost: 0.7 },
  { sku: "ACEITE-OVE", name: "Aceite oliva virgen extra", category: "Cocina", unit: "L", minLevel: 3, unitCost: 7.5 },
  { sku: "AGUA-1L", name: "Agua mineral (botella 1 L)", category: "Bebidas", unit: "botella", minLevel: 24, unitCost: 0.4 },
  { sku: "PAN-BARRA", name: "Pan barra fresco", category: "Cocina", unit: "unidad", minLevel: 20, unitCost: 0.45 }
];

// MenuItem name → outletId + price + tax + recipes (inventory sku → qty)
const MENU = [
  { outletId: "out_restaurant", name: "Menú del día", category: "Comida", price: 18.5, taxRate: 10, recipes: [["PATATAS", 0.35], ["ACEITE-OVE", 0.05], ["PAN-BARRA", 1.0], ["QUESO-MANCHEGO", 0.05]] },
  { outletId: "out_restaurant", name: "Copa de vino", category: "Vinos", price: 4.5, taxRate: 21, recipes: [["VINO-RIOJA", 0.15]] },
  { outletId: "out_bar", name: "Caña", category: "Bebidas", price: 3.0, taxRate: 21, recipes: [["AGUA-1L", 0.05]] /* simplificación demo */ },
  { outletId: "out_bar", name: "Ración de jamón", category: "Tapas", price: 14.0, taxRate: 21, recipes: [["QUESO-MANCHEGO", 0.08], ["PAN-BARRA", 1.0]] },
  { outletId: "out_cafe", name: "Café con leche", category: "Cafetería", price: 2.4, taxRate: 10, recipes: [["CAFE-MOL", 0.008], ["LECHE-UHT", 0.18]] },
  { outletId: "out_cafe", name: "Tarta de queso", category: "Postres", price: 5.5, taxRate: 10, recipes: [["QUESO-MANCHEGO", 0.12]] }
];

async function main() {
  const property = await prisma.property.findUnique({ where: { id: PID }, select: { id: true, name: true } });
  if (!property) throw new Error(`Property ${PID} not found`);
  console.log(`[fnb] property ${PID} (${property.name})`);

  // Wipe previous seeded records (ids starting with "fnb_seed_")
  const oldMenu = await prisma.menuItem.findMany({ where: { propertyId: PID, sku: { startsWith: "MENU-SEED-" } }, select: { id: true } });
  if (oldMenu.length > 0) {
    await prisma.menuRecipe.deleteMany({ where: { menuItemId: { in: oldMenu.map((m) => m.id) } } });
    await prisma.menuItem.deleteMany({ where: { id: { in: oldMenu.map((m) => m.id) } } });
  }
  const oldItems = await prisma.inventoryItem.findMany({ where: { propertyId: PID, sku: { startsWith: "VINO-RIOJA" } }, select: { id: true } });
  if (oldItems.length > 0) {
    await prisma.stockMovement.deleteMany({ where: { inventoryItemId: { in: oldItems.map((i) => i.id) } } });
  }

  // Stock location (idempotent: only create if no F&B location exists)
  let location = await prisma.stockLocation.findFirst({ where: { propertyId: PID, locationType: "fnb" } });
  if (!location) {
    location = await prisma.stockLocation.create({
      data: { propertyId: PID, name: "Almacén F&B", locationType: "fnb", active: true }
    });
  }
  console.log(`[fnb] stock location: ${location.name}`);

  // Inventory items (upsert by propertyId + sku effectively — there's no
  // unique constraint, so we deduplicate manually)
  const itemBySku = new Map<string, string>();
  for (const it of ITEMS) {
    const existing = await prisma.inventoryItem.findFirst({ where: { propertyId: PID, sku: it.sku } });
    let item;
    if (existing) {
      item = await prisma.inventoryItem.update({ where: { id: existing.id }, data: { name: it.name, category: it.category, unit: it.unit, minLevel: it.minLevel, unitCost: it.unitCost, active: true } });
    } else {
      item = await prisma.inventoryItem.create({ data: { propertyId: PID, sku: it.sku, name: it.name, category: it.category, unit: it.unit, minLevel: it.minLevel, unitCost: it.unitCost, active: true } });
    }
    itemBySku.set(it.sku, item.id);
  }
  console.log(`[fnb] ${ITEMS.length} inventory items`);

  // Opening balances (only if no opening_balance movement exists for the item)
  let openingMovements = 0;
  for (const it of ITEMS) {
    const itemId = itemBySku.get(it.sku)!;
    const hasOpening = await prisma.stockMovement.findFirst({ where: { inventoryItemId: itemId, movementType: "opening_balance" } });
    if (!hasOpening) {
      // Generous opening: ~5x the minLevel
      const openingQty = (it.minLevel ?? 1) * 5;
      await prisma.stockMovement.create({
        data: {
          propertyId: PID,
          inventoryItemId: itemId,
          stockLocationId: location.id,
          movementType: "opening_balance",
          quantity: openingQty,
          unitCost: it.unitCost,
          sourceType: "seed"
        }
      });
      openingMovements += 1;
    }
  }
  console.log(`[fnb] ${openingMovements} opening_balance movements`);

  // Menu items + recipes
  let createdMenus = 0;
  let recipeRows = 0;
  for (const m of MENU) {
    // Upsert via propertyId+outletId+name (the schema has the unique constraint)
    const sku = `MENU-SEED-${m.outletId.replace(/[^A-Z0-9]/gi, "").toUpperCase()}-${m.name.replace(/[^A-Z0-9]/gi, "").toUpperCase()}`.slice(0, 60);
    const existing = await prisma.menuItem.findFirst({ where: { propertyId: PID, outletId: m.outletId, name: m.name } });
    const menuItem = existing
      ? await prisma.menuItem.update({ where: { id: existing.id }, data: { category: m.category, price: m.price, taxRate: m.taxRate, sku, active: true } })
      : await prisma.menuItem.create({ data: { propertyId: PID, outletId: m.outletId, name: m.name, category: m.category, price: m.price, taxRate: m.taxRate, sku, active: true } });
    createdMenus += 1;

    // Clear existing recipes for this menu item to keep idempotency simple
    await prisma.menuRecipe.deleteMany({ where: { menuItemId: menuItem.id } });
    for (const [sku, qty] of m.recipes) {
      const invId = itemBySku.get(sku as string);
      if (!invId) continue;
      await prisma.menuRecipe.create({ data: { menuItemId: menuItem.id, inventoryItemId: invId, quantity: qty as number } });
      recipeRows += 1;
    }
  }
  console.log(`[fnb] ${createdMenus} menu items · ${recipeRows} recipe rows`);
  console.log("[fnb] listo.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
