// Seed: cadena hotelera mediana con 8 propiedades reales en España.
//
// Diseño:
//   - Mismo `organizationId` ("org_chain_iberia") → la cadena consolida en
//     todos los paneles multi-propiedad (Portfolio, USALI, Compliance Center…).
//   - Variedad deliberada:
//       * Tamaño: 28 → 210 habitaciones
//       * Tipología: urbano · resort costero · boutique · 5* lujo · negocios · cultural · resort isla · histórico
//       * CCAA distintas: Madrid · Cataluña · Andalucía (×2) · CV · País Vasco (foral) · Baleares · Andalucía hist.
//       * Régimen fiscal: VeriFactu (común) vs TBAI (Bizkaia foral) vs IGIC (Canarias N/A aquí)
//       * Tasa turística aplicable: CAT, BAL, EUSK (tres de las cuatro)
//   - Cada hotel tiene:
//       * 3-6 room types con precio y capacidad coherentes
//       * Habitaciones numeradas según convención del tamaño
//       * 1-3 rate plans (BAR + non-refundable + a veces breakfast included)
//       * 1-3 outlets F&B (restaurante / bar / room service / pool bar en resorts)
//       * Stock locations (cocina principal, bar central, bodega, almacén)
//       * 10-20 inventory items (productos por categoría: aceite, vino, cerveza, café, carnes…)
//       * 8-15 menu items con recetas (escandallos) que descuentan stock al vender
//       * 1-3 cancellation policies
//       * Allotments + tour operators en los resorts costeros
//
// Idempotente: usa `upsert` por `(propertyId, code)` o equivalente. Re-ejecutarlo
// no duplica datos; actualiza in-place.

import { prisma } from "@hotelos/database";

const ORG_ID = "org_chain_iberia";

// ===========================================================================
// Catálogo de 8 hoteles — datos coherentes con la realidad española
// ===========================================================================

type HotelSpec = {
  id: string;
  name: string;
  legalName: string;
  address: string;
  municipality: string;
  province: string;
  taxRegion: string; // for VeriFactu vs TBAI routing
  timezone: string;
  ccaaCode: "MAD" | "CAT" | "AND" | "VC" | "EUSK" | "BAL";
  establishmentClass: string; // p.ej. 5_estrellas, 4_estrellas, lujo_5e
  category: "urban" | "resort" | "boutique" | "luxury" | "business" | "cultural" | "historic";
  brand: string;
  roomTypes: Array<{
    code: string;
    name: string;
    maxOccupancy: number;
    baseCapacity: number;
    basePrice: number;
    bedConfig: string;
    qty: number; // cuántas habitaciones se generan de este tipo
  }>;
  ratePlans: Array<{
    code: string;
    name: string;
    ratePlanType: string; // BAR / NRF / PROMO / GROUP
    mealPlan?: string;
  }>;
  outlets: Array<{
    code: string; // outletId (string libre)
    name: string;
    type: "restaurant" | "bar" | "room_service" | "pool_bar" | "rooftop" | "spa_cafe";
  }>;
  hasAllotments: boolean; // sólo los resorts
  hasSpa: boolean;
  hasParking: boolean;
};

const HOTELS: HotelSpec[] = [
  {
    id: "prop_iberia_madrid",
    name: "Iberia Madrid Centro",
    legalName: "Iberia Hoteles Madrid SL",
    address: "Gran Vía 28",
    municipality: "Madrid",
    province: "Madrid",
    taxRegion: "common", // VeriFactu
    timezone: "Europe/Madrid",
    ccaaCode: "MAD",
    establishmentClass: "4_estrellas",
    category: "urban",
    brand: "Iberia Hoteles",
    roomTypes: [
      { code: "STD", name: "Doble estándar", maxOccupancy: 2, baseCapacity: 2, basePrice: 145, bedConfig: "1 cama matrimonial o 2 individuales", qty: 32 },
      { code: "SUP", name: "Doble superior con vistas", maxOccupancy: 2, baseCapacity: 2, basePrice: 185, bedConfig: "1 king size", qty: 18 },
      { code: "TRP", name: "Triple familiar", maxOccupancy: 3, baseCapacity: 3, basePrice: 215, bedConfig: "1 matrimonial + 1 individual", qty: 8 },
      { code: "JST", name: "Junior Suite", maxOccupancy: 3, baseCapacity: 2, basePrice: 285, bedConfig: "1 king + sofá cama", qty: 6 }
    ],
    ratePlans: [
      { code: "BAR", name: "Mejor tarifa flexible", ratePlanType: "BAR", mealPlan: "RO" },
      { code: "BAR_BB", name: "BAR con desayuno", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "NRF", name: "No reembolsable -15%", ratePlanType: "NRF", mealPlan: "RO" }
    ],
    outlets: [
      { code: "rest_main", name: "Restaurante Gran Vía", type: "restaurant" },
      { code: "bar_lobby", name: "Lobby Bar", type: "bar" },
      { code: "rs", name: "Room Service", type: "room_service" }
    ],
    hasAllotments: false,
    hasSpa: false,
    hasParking: true
  },
  {
    id: "prop_iberia_barcelona",
    name: "Iberia Barcelona Beach",
    legalName: "Iberia Hoteles Barcelona SL",
    address: "Passeig Marítim 47",
    municipality: "Barcelona",
    province: "Barcelona",
    taxRegion: "common",
    timezone: "Europe/Madrid",
    ccaaCode: "CAT",
    establishmentClass: "4_estrellas",
    category: "resort",
    brand: "Iberia Hoteles",
    roomTypes: [
      { code: "STD", name: "Doble estándar", maxOccupancy: 2, baseCapacity: 2, basePrice: 175, bedConfig: "1 matrimonial o 2 individuales", qty: 60 },
      { code: "SEA", name: "Doble vistas al mar", maxOccupancy: 2, baseCapacity: 2, basePrice: 230, bedConfig: "1 king + balcón al mar", qty: 35 },
      { code: "FAM", name: "Familiar 4 personas", maxOccupancy: 4, baseCapacity: 4, basePrice: 295, bedConfig: "1 matrimonial + 2 individuales", qty: 18 },
      { code: "STE", name: "Suite mar", maxOccupancy: 3, baseCapacity: 2, basePrice: 420, bedConfig: "1 king + sofá cama + terraza", qty: 7 }
    ],
    ratePlans: [
      { code: "BAR", name: "Mejor tarifa flexible", ratePlanType: "BAR", mealPlan: "RO" },
      { code: "BAR_BB", name: "BAR con desayuno buffet", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "NRF", name: "No reembolsable -20%", ratePlanType: "NRF", mealPlan: "RO" },
      { code: "HB_SUMMER", name: "Media pensión verano", ratePlanType: "BAR", mealPlan: "HB" }
    ],
    outlets: [
      { code: "rest_main", name: "Restaurante Marisol", type: "restaurant" },
      { code: "bar_lobby", name: "Lobby Bar", type: "bar" },
      { code: "pool_bar", name: "Chiringuito Piscina", type: "pool_bar" },
      { code: "rs", name: "Room Service 24h", type: "room_service" }
    ],
    hasAllotments: true,
    hasSpa: true,
    hasParking: true
  },
  {
    id: "prop_iberia_sevilla",
    name: "Iberia Sevilla Boutique",
    legalName: "Iberia Hoteles Sevilla SL",
    address: "Calle Cuna 12",
    municipality: "Sevilla",
    province: "Sevilla",
    taxRegion: "common",
    timezone: "Europe/Madrid",
    ccaaCode: "AND",
    establishmentClass: "4_estrellas",
    category: "boutique",
    brand: "Iberia Boutique",
    roomTypes: [
      { code: "PATIO", name: "Doble con patio", maxOccupancy: 2, baseCapacity: 2, basePrice: 195, bedConfig: "1 matrimonial", qty: 16 },
      { code: "SUP", name: "Doble superior", maxOccupancy: 2, baseCapacity: 2, basePrice: 235, bedConfig: "1 king", qty: 12 },
      { code: "STE", name: "Suite tradicional", maxOccupancy: 3, baseCapacity: 2, basePrice: 380, bedConfig: "1 king + sofá", qty: 7 }
    ],
    ratePlans: [
      { code: "BAR_BB", name: "BAR con desayuno", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "NRF", name: "No reembolsable -18%", ratePlanType: "NRF", mealPlan: "BB" }
    ],
    outlets: [
      { code: "rest_main", name: "Restaurante El Patio", type: "restaurant" },
      { code: "bar_lobby", name: "Bar Cuna", type: "bar" }
    ],
    hasAllotments: false,
    hasSpa: false,
    hasParking: false
  },
  {
    id: "prop_iberia_marbella",
    name: "Iberia Marbella Lujo Resort",
    legalName: "Iberia Hoteles Marbella SL",
    address: "Av. Bulevar Príncipe Alfonso de Hohenlohe s/n",
    municipality: "Marbella",
    province: "Málaga",
    taxRegion: "common",
    timezone: "Europe/Madrid",
    ccaaCode: "AND",
    establishmentClass: "5_estrellas",
    category: "luxury",
    brand: "Iberia Lujo Collection",
    roomTypes: [
      { code: "DLX", name: "Doble Deluxe", maxOccupancy: 2, baseCapacity: 2, basePrice: 380, bedConfig: "1 king", qty: 80 },
      { code: "SEA", name: "Doble Deluxe vistas mar", maxOccupancy: 2, baseCapacity: 2, basePrice: 480, bedConfig: "1 king + terraza", qty: 55 },
      { code: "JST", name: "Junior Suite", maxOccupancy: 3, baseCapacity: 2, basePrice: 695, bedConfig: "1 king + salón", qty: 30 },
      { code: "STE", name: "Suite Ejecutiva", maxOccupancy: 4, baseCapacity: 2, basePrice: 1080, bedConfig: "1 king + 2 baños + terraza panorámica", qty: 12 },
      { code: "PRS", name: "Presidential Suite", maxOccupancy: 4, baseCapacity: 2, basePrice: 2400, bedConfig: "Suite 180m² · piscina privada", qty: 3 }
    ],
    ratePlans: [
      { code: "BAR_BB", name: "BAR con desayuno gourmet", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "BAR_HB", name: "BAR media pensión", ratePlanType: "BAR", mealPlan: "HB" },
      { code: "NRF_BB", name: "No reembolsable -15% con desayuno", ratePlanType: "NRF", mealPlan: "BB" },
      { code: "ALL_INC", name: "All inclusive verano", ratePlanType: "BAR", mealPlan: "AI" }
    ],
    outlets: [
      { code: "rest_main", name: "Restaurante La Terraza", type: "restaurant" },
      { code: "rest_gourmet", name: "Restaurante Atelier (1★ Michelin)", type: "restaurant" },
      { code: "bar_lobby", name: "Lobby Bar", type: "bar" },
      { code: "pool_bar", name: "Pool Bar Mediterráneo", type: "pool_bar" },
      { code: "rooftop", name: "Sky Bar", type: "rooftop" },
      { code: "spa_cafe", name: "Café Wellness", type: "spa_cafe" },
      { code: "rs", name: "Room Service 24h", type: "room_service" }
    ],
    hasAllotments: true,
    hasSpa: true,
    hasParking: true
  },
  {
    id: "prop_iberia_valencia",
    name: "Iberia Valencia Negocios",
    legalName: "Iberia Hoteles Valencia SL",
    address: "Av. de Aragón 30",
    municipality: "Valencia",
    province: "Valencia",
    taxRegion: "common",
    timezone: "Europe/Madrid",
    ccaaCode: "VC",
    establishmentClass: "4_estrellas",
    category: "business",
    brand: "Iberia Hoteles",
    roomTypes: [
      { code: "STD", name: "Doble estándar business", maxOccupancy: 2, baseCapacity: 2, basePrice: 135, bedConfig: "1 king o 2 individuales", qty: 55 },
      { code: "EXC", name: "Doble Executive Lounge", maxOccupancy: 2, baseCapacity: 2, basePrice: 175, bedConfig: "1 king + acceso lounge", qty: 25 },
      { code: "JST", name: "Junior Suite", maxOccupancy: 2, baseCapacity: 2, basePrice: 245, bedConfig: "1 king + salón", qty: 10 }
    ],
    ratePlans: [
      { code: "BAR", name: "Tarifa empresarial flexible", ratePlanType: "BAR", mealPlan: "RO" },
      { code: "BAR_BB", name: "BAR con desayuno buffet", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "CORP", name: "Tarifa corporativa contrato", ratePlanType: "BAR", mealPlan: "BB" }
    ],
    outlets: [
      { code: "rest_main", name: "Restaurante L'Horta", type: "restaurant" },
      { code: "bar_lobby", name: "Bar Mediterráneo", type: "bar" },
      { code: "rs", name: "Room Service", type: "room_service" }
    ],
    hasAllotments: false,
    hasSpa: false,
    hasParking: true
  },
  {
    id: "prop_iberia_bilbao",
    name: "Iberia Bilbao Cultura",
    legalName: "Iberia Hoteles Bilbao SL",
    address: "Alameda de Mazarredo 17",
    municipality: "Bilbao",
    province: "Bizkaia", // → TBAI Bizkaia
    taxRegion: "bizkaia",
    timezone: "Europe/Madrid",
    ccaaCode: "EUSK",
    establishmentClass: "4_estrellas",
    category: "cultural",
    brand: "Iberia Hoteles",
    roomTypes: [
      { code: "STD", name: "Doble estándar", maxOccupancy: 2, baseCapacity: 2, basePrice: 165, bedConfig: "1 matrimonial o 2 individuales", qty: 42 },
      { code: "DSGN", name: "Doble diseño", maxOccupancy: 2, baseCapacity: 2, basePrice: 210, bedConfig: "1 king + vistas Guggenheim", qty: 15 },
      { code: "STE", name: "Suite Mazarredo", maxOccupancy: 3, baseCapacity: 2, basePrice: 320, bedConfig: "1 king + salón", qty: 3 }
    ],
    ratePlans: [
      { code: "BAR_BB", name: "BAR con desayuno", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "NRF", name: "No reembolsable -15%", ratePlanType: "NRF", mealPlan: "RO" }
    ],
    outlets: [
      { code: "rest_main", name: "Restaurante Mazarredo", type: "restaurant" },
      { code: "bar_lobby", name: "Pintxo Bar", type: "bar" }
    ],
    hasAllotments: false,
    hasSpa: false,
    hasParking: true
  },
  {
    id: "prop_iberia_mallorca",
    name: "Iberia Mallorca Resort & Spa",
    legalName: "Iberia Hoteles Mallorca SL",
    address: "Carretera de Cala d'Or s/n",
    municipality: "Felanitx",
    province: "Illes Balears",
    taxRegion: "common",
    timezone: "Europe/Madrid",
    ccaaCode: "BAL",
    establishmentClass: "5_estrellas",
    category: "resort",
    brand: "Iberia Resorts",
    roomTypes: [
      { code: "STD", name: "Doble estándar", maxOccupancy: 2, baseCapacity: 2, basePrice: 220, bedConfig: "1 matrimonial o 2 individuales", qty: 85 },
      { code: "SEA", name: "Doble vistas mar", maxOccupancy: 2, baseCapacity: 2, basePrice: 295, bedConfig: "1 king + terraza vistas", qty: 70 },
      { code: "FAM", name: "Familiar comunicadas", maxOccupancy: 5, baseCapacity: 4, basePrice: 380, bedConfig: "2 hab. comunicadas", qty: 28 },
      { code: "JST", name: "Junior Suite piscina", maxOccupancy: 3, baseCapacity: 2, basePrice: 510, bedConfig: "1 king + acceso piscina", qty: 20 },
      { code: "STE", name: "Suite Maestra", maxOccupancy: 4, baseCapacity: 2, basePrice: 825, bedConfig: "Suite 100m² + jacuzzi privado", qty: 7 }
    ],
    ratePlans: [
      { code: "BAR_BB", name: "BAR con desayuno", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "BAR_HB", name: "Media pensión", ratePlanType: "BAR", mealPlan: "HB" },
      { code: "ALL_INC", name: "All inclusive", ratePlanType: "BAR", mealPlan: "AI" },
      { code: "NRF_BB", name: "No reembolsable -20%", ratePlanType: "NRF", mealPlan: "BB" }
    ],
    outlets: [
      { code: "rest_buffet", name: "Buffet Mediterráneo", type: "restaurant" },
      { code: "rest_grill", name: "Beach Grill", type: "restaurant" },
      { code: "rest_asian", name: "Restaurante Asiático Sakura", type: "restaurant" },
      { code: "bar_lobby", name: "Lobby Bar", type: "bar" },
      { code: "pool_bar", name: "Pool Bar Atlántica", type: "pool_bar" },
      { code: "bar_beach", name: "Chiringuito Cala", type: "pool_bar" },
      { code: "spa_cafe", name: "Wellness Café", type: "spa_cafe" },
      { code: "rs", name: "Room Service 24h", type: "room_service" }
    ],
    hasAllotments: true,
    hasSpa: true,
    hasParking: true
  },
  {
    id: "prop_iberia_granada",
    name: "Iberia Granada Histórico",
    legalName: "Iberia Hoteles Granada SL",
    address: "Cuesta de Gomérez 8",
    municipality: "Granada",
    province: "Granada",
    taxRegion: "common",
    timezone: "Europe/Madrid",
    ccaaCode: "AND",
    establishmentClass: "4_estrellas",
    category: "historic",
    brand: "Iberia Heritage",
    roomTypes: [
      { code: "STD", name: "Doble tradicional", maxOccupancy: 2, baseCapacity: 2, basePrice: 165, bedConfig: "1 matrimonial", qty: 14 },
      { code: "SUP", name: "Doble vistas Alhambra", maxOccupancy: 2, baseCapacity: 2, basePrice: 235, bedConfig: "1 king + ventanal Alhambra", qty: 10 },
      { code: "STE", name: "Suite Nazarí", maxOccupancy: 3, baseCapacity: 2, basePrice: 410, bedConfig: "Suite con artesonado mudéjar", qty: 4 }
    ],
    ratePlans: [
      { code: "BAR_BB", name: "BAR con desayuno", ratePlanType: "BAR", mealPlan: "BB" },
      { code: "NRF", name: "No reembolsable -15%", ratePlanType: "NRF", mealPlan: "BB" }
    ],
    outlets: [
      { code: "rest_main", name: "Restaurante Alhambra", type: "restaurant" },
      { code: "bar_lobby", name: "Bar Mirador", type: "bar" }
    ],
    hasAllotments: false,
    hasSpa: false,
    hasParking: false
  }
];

// ===========================================================================
// Inventario común a casi todos los hoteles (categorías reales)
// ===========================================================================

type InventoryItemSpec = { code: string; name: string; category: string; unit: string; unitCost: number; minLevel: number };

const COMMON_INVENTORY: InventoryItemSpec[] = [
  // Cocina · básicos
  { code: "ACEITE-OVE", name: "Aceite oliva virgen extra", category: "cocina", unit: "L", unitCost: 6.80, minLevel: 3 },
  { code: "SAL-COC", name: "Sal cocina", category: "cocina", unit: "kg", unitCost: 1.10, minLevel: 2 },
  { code: "AZUC-COC", name: "Azúcar blanco", category: "cocina", unit: "kg", unitCost: 1.40, minLevel: 5 },
  { code: "HAR-TRG", name: "Harina trigo", category: "cocina", unit: "kg", unitCost: 0.90, minLevel: 8 },
  { code: "ARR-BOM", name: "Arroz bomba", category: "cocina", unit: "kg", unitCost: 4.20, minLevel: 6 },
  // Cocina · proteínas
  { code: "POL-PEC", name: "Pechuga pollo", category: "cocina", unit: "kg", unitCost: 7.20, minLevel: 4 },
  { code: "TER-SOL", name: "Solomillo de ternera", category: "cocina", unit: "kg", unitCost: 28.00, minLevel: 2 },
  { code: "MER-FIL", name: "Filete merluza fresca", category: "cocina", unit: "kg", unitCost: 14.50, minLevel: 3 },
  // Cocina · verduras
  { code: "TOM-COC", name: "Tomate maduro", category: "cocina", unit: "kg", unitCost: 1.80, minLevel: 5 },
  { code: "PAT-FRE", name: "Patatas frescas", category: "cocina", unit: "kg", unitCost: 1.20, minLevel: 10 },
  { code: "PIM-MIX", name: "Pimientos rojo/verde", category: "cocina", unit: "kg", unitCost: 2.40, minLevel: 4 },
  // Cocina · lácteos
  { code: "LECHE-UHT", name: "Leche entera UHT", category: "cocina", unit: "L", unitCost: 0.95, minLevel: 20 },
  { code: "MNTQ", name: "Mantequilla", category: "cocina", unit: "kg", unitCost: 8.40, minLevel: 2 },
  { code: "HUEVOS", name: "Huevos M (docena)", category: "cocina", unit: "docena", unitCost: 2.80, minLevel: 8 },
  // Cocina · panadería
  { code: "PAN-BAR", name: "Pan barra fresco", category: "cocina", unit: "unidad", unitCost: 0.85, minLevel: 30 },
  // Bar · vinos
  { code: "VIN-RIO", name: "Vino Rioja Reserva (botella 75cl)", category: "bar", unit: "botella", unitCost: 8.50, minLevel: 12 },
  { code: "VIN-RIB", name: "Vino Ribera del Duero crianza", category: "bar", unit: "botella", unitCost: 9.80, minLevel: 8 },
  { code: "VIN-ALB", name: "Vino blanco Albariño", category: "bar", unit: "botella", unitCost: 7.40, minLevel: 10 },
  { code: "CAVA", name: "Cava brut nature", category: "bar", unit: "botella", unitCost: 6.20, minLevel: 6 },
  // Bar · cervezas y refrescos
  { code: "CER-CAN", name: "Cerveza Mahou caña (5L)", category: "bar", unit: "barril", unitCost: 38.00, minLevel: 4 },
  { code: "CER-EST", name: "Cerveza Estrella Galicia (33cl)", category: "bar", unit: "botella", unitCost: 0.95, minLevel: 60 },
  { code: "REF-COL", name: "Coca-Cola lata 33cl", category: "bar", unit: "lata", unitCost: 0.55, minLevel: 60 },
  { code: "AGUA-MIN", name: "Agua mineral 1L", category: "bar", unit: "botella", unitCost: 0.35, minLevel: 80 },
  // Bar · destilados
  { code: "GIN-PRM", name: "Ginebra premium (botella 70cl)", category: "bar", unit: "botella", unitCost: 18.00, minLevel: 3 },
  { code: "WSK-RES", name: "Whisky reserva (botella 70cl)", category: "bar", unit: "botella", unitCost: 22.50, minLevel: 3 },
  // Cafetería
  { code: "CAFE-MOL", name: "Café molido tueste natural", category: "cafeteria", unit: "kg", unitCost: 14.50, minLevel: 4 },
  { code: "TE-VAR", name: "Té variedades", category: "cafeteria", unit: "caja-100", unitCost: 18.00, minLevel: 2 }
];

// ===========================================================================
// Menú base — platos que pueden adaptarse por hotel
// ===========================================================================

type MenuItemSpec = {
  outletCode: string;
  sku: string;
  name: string;
  category: string;
  price: number;
  taxRate: number;
  recipe: Array<{ inventoryCode: string; quantity: number }>;
};

const BASE_MENU: MenuItemSpec[] = [
  // Restaurante · entrantes
  { outletCode: "rest_main", sku: "ENS-MIX", name: "Ensalada mixta", category: "entrantes", price: 9.50, taxRate: 10, recipe: [
    { inventoryCode: "TOM-COC", quantity: 0.10 }, { inventoryCode: "ACEITE-OVE", quantity: 0.015 }, { inventoryCode: "SAL-COC", quantity: 0.002 }
  ]},
  { outletCode: "rest_main", sku: "TORT-PAT", name: "Tortilla de patatas", category: "entrantes", price: 11.00, taxRate: 10, recipe: [
    { inventoryCode: "HUEVOS", quantity: 0.33 }, { inventoryCode: "PAT-FRE", quantity: 0.20 }, { inventoryCode: "ACEITE-OVE", quantity: 0.04 }
  ]},
  // Restaurante · platos principales
  { outletCode: "rest_main", sku: "MER-VAS", name: "Merluza a la vasca", category: "principales", price: 24.50, taxRate: 10, recipe: [
    { inventoryCode: "MER-FIL", quantity: 0.20 }, { inventoryCode: "ACEITE-OVE", quantity: 0.025 }, { inventoryCode: "TOM-COC", quantity: 0.08 }, { inventoryCode: "PIM-MIX", quantity: 0.06 }
  ]},
  { outletCode: "rest_main", sku: "SOL-PIM", name: "Solomillo a la pimienta", category: "principales", price: 32.00, taxRate: 10, recipe: [
    { inventoryCode: "TER-SOL", quantity: 0.18 }, { inventoryCode: "ACEITE-OVE", quantity: 0.02 }, { inventoryCode: "PAT-FRE", quantity: 0.15 }, { inventoryCode: "MNTQ", quantity: 0.02 }
  ]},
  { outletCode: "rest_main", sku: "POL-PLN", name: "Pechuga de pollo a la plancha", category: "principales", price: 16.50, taxRate: 10, recipe: [
    { inventoryCode: "POL-PEC", quantity: 0.20 }, { inventoryCode: "ACEITE-OVE", quantity: 0.02 }, { inventoryCode: "PAT-FRE", quantity: 0.18 }
  ]},
  { outletCode: "rest_main", sku: "PAE-VAL", name: "Paella valenciana", category: "principales", price: 21.00, taxRate: 10, recipe: [
    { inventoryCode: "ARR-BOM", quantity: 0.12 }, { inventoryCode: "POL-PEC", quantity: 0.12 }, { inventoryCode: "PIM-MIX", quantity: 0.08 }, { inventoryCode: "ACEITE-OVE", quantity: 0.03 }
  ]},
  // Restaurante · postres
  { outletCode: "rest_main", sku: "CRE-CAT", name: "Crema catalana", category: "postres", price: 6.50, taxRate: 10, recipe: [
    { inventoryCode: "LECHE-UHT", quantity: 0.20 }, { inventoryCode: "HUEVOS", quantity: 0.17 }, { inventoryCode: "AZUC-COC", quantity: 0.04 }
  ]},
  // Bar
  { outletCode: "bar_lobby", sku: "COP-RIO", name: "Copa Rioja Reserva", category: "vinos", price: 5.50, taxRate: 21, recipe: [
    { inventoryCode: "VIN-RIO", quantity: 0.15 }
  ]},
  { outletCode: "bar_lobby", sku: "GIN-TON", name: "Gin tonic premium", category: "cocteles", price: 11.00, taxRate: 21, recipe: [
    { inventoryCode: "GIN-PRM", quantity: 0.05 }, { inventoryCode: "AGUA-MIN", quantity: 0.25 }
  ]},
  { outletCode: "bar_lobby", sku: "CAF-LEC", name: "Café con leche", category: "cafeteria", price: 2.80, taxRate: 10, recipe: [
    { inventoryCode: "CAFE-MOL", quantity: 0.008 }, { inventoryCode: "LECHE-UHT", quantity: 0.15 }
  ]},
  { outletCode: "bar_lobby", sku: "CER-CAN-1", name: "Caña Mahou", category: "cervezas", price: 3.20, taxRate: 21, recipe: [
    { inventoryCode: "CER-CAN", quantity: 0.20 }
  ]}
];

// ===========================================================================
// Helpers
// ===========================================================================

function generateRoomNumbers(qty: number, floorStart: number): Array<{ number: string; floor: number }> {
  const rooms: Array<{ number: string; floor: number }> = [];
  let n = 1;
  let floor = floorStart;
  let perFloor = qty <= 30 ? 10 : qty <= 80 ? 20 : 35;
  for (let i = 0; i < qty; i++) {
    if (i > 0 && i % perFloor === 0) floor += 1;
    const local = (i % perFloor) + 1;
    rooms.push({ number: `${floor}${String(local).padStart(2, "0")}`, floor });
  }
  return rooms;
}

// ===========================================================================
// Seed runner
// ===========================================================================

async function ensureOrganization() {
  const existing = await prisma.organization.findUnique({ where: { id: ORG_ID } }).catch(() => null);
  if (existing) return existing;
  return prisma.organization.create({
    data: {
      id: ORG_ID,
      name: "Iberia Hoteles Group",
      legalName: "Iberia Hoteles Group SA",
      country: "ES"
    }
  });
}

// Tour operators a nivel de cadena — los allotments por hotel se cuelgan de aquí.
async function ensureTourOperators() {
  const operators = [
    {
      code: "TUI",
      name: "TUI Group",
      taxId: "DE123456789",
      contactEmail: "contracting@tui.com",
      defaultCommissionPct: 22,
      paymentTermsDays: 45
    },
    {
      code: "JET2",
      name: "Jet2 Holidays",
      taxId: "GB987654321",
      contactEmail: "hotels@jet2holidays.com",
      defaultCommissionPct: 20,
      paymentTermsDays: 30
    },
    {
      code: "HOTELBEDS",
      name: "Hotelbeds (Bedbank)",
      taxId: "ESB57276511",
      contactEmail: "contracting@hotelbeds.com",
      defaultCommissionPct: 18,
      paymentTermsDays: 30
    }
  ];
  for (const op of operators) {
    await prisma.tourOperator.upsert({
      where: { organizationId_code: { organizationId: ORG_ID, code: op.code } } as never,
      create: {
        organizationId: ORG_ID,
        code: op.code,
        name: op.name,
        taxId: op.taxId,
        contactEmail: op.contactEmail,
        defaultCommissionPct: op.defaultCommissionPct,
        paymentTermsDays: op.paymentTermsDays,
        currency: "EUR",
        active: true
      },
      update: {
        name: op.name,
        defaultCommissionPct: op.defaultCommissionPct,
        active: true
      }
    });
  }
}

// Tasa turística — garantiza que existen tarifas para CCAA representadas en la cadena.
// CAT (Cataluña), BAL (Baleares) y EUSK (País Vasco — Donostia/SS aplica tasa local pero
// Bilbao no; aquí seedeamos a nivel CCAA por defecto). El servicio ya tiene un seed
// genérico — sólo lo invocamos si no hay tarifas.
async function ensureTouristTaxRates() {
  const count = await prisma.touristTaxRate.count();
  if (count >= 6) return;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rates: Array<{
    ccaaCode: string;
    municipality?: string;
    establishmentClass: string;
    amountPerPersonNight: number;
    highSeasonSurcharge?: number;
    highSeasonFromMmdd?: string;
    highSeasonUntilMmdd?: string;
    maxNightsPerStay?: number;
    legalSource: string;
  }> = [
    // Cataluña — Generalitat (Llei 5/2017 art. 49). Valores 2024.
    { ccaaCode: "CAT", establishmentClass: "5_estrellas", amountPerPersonNight: 3.5, maxNightsPerStay: 7, legalSource: "Llei 5/2017 Catalunya" },
    { ccaaCode: "CAT", establishmentClass: "4_estrellas", amountPerPersonNight: 1.7, maxNightsPerStay: 7, legalSource: "Llei 5/2017 Catalunya" },
    { ccaaCode: "CAT", municipality: "Barcelona", establishmentClass: "5_estrellas", amountPerPersonNight: 4.0, maxNightsPerStay: 7, legalSource: "Llei 5/2017 + recarrec municipal Barcelona" },
    { ccaaCode: "CAT", municipality: "Barcelona", establishmentClass: "4_estrellas", amountPerPersonNight: 3.2, maxNightsPerStay: 7, legalSource: "Llei 5/2017 + recarrec municipal Barcelona" },
    // Baleares — IETS (Llei 2/2016). Verano sobrecargo +100% (1 € → 2 €) entre may-oct.
    { ccaaCode: "BAL", establishmentClass: "5_estrellas", amountPerPersonNight: 2.0, highSeasonSurcharge: 1.0, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Llei 2/2016 Illes Balears" },
    { ccaaCode: "BAL", establishmentClass: "4_estrellas", amountPerPersonNight: 1.5, highSeasonSurcharge: 1.0, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Llei 2/2016 Illes Balears" },
    { ccaaCode: "BAL", establishmentClass: "3_estrellas", amountPerPersonNight: 1.0, highSeasonSurcharge: 1.0, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Llei 2/2016 Illes Balears" },
    // Euskadi — sólo Donostia y Bilbao tienen tasa municipal aprobada (proyecto Ley Foral
    // del Turismo). Bilbao no la aplica todavía en 2026 pero la dejamos preparada.
    { ccaaCode: "EUSK", municipality: "Bilbao", establishmentClass: "4_estrellas", amountPerPersonNight: 1.5, legalSource: "Proyecto Ley Foral Turismo Bizkaia" }
  ];
  for (const r of rates) {
    await prisma.touristTaxRate.create({
      data: {
        country: "ES",
        ccaaCode: r.ccaaCode,
        municipality: r.municipality ?? null,
        establishmentClass: r.establishmentClass,
        amountPerPersonNight: r.amountPerPersonNight,
        currency: "EUR",
        validFrom: today,
        validUntil: null,
        maxNightsPerStay: r.maxNightsPerStay ?? 0,
        highSeasonSurcharge: r.highSeasonSurcharge ?? null,
        highSeasonFromMmdd: r.highSeasonFromMmdd ?? null,
        highSeasonUntilMmdd: r.highSeasonUntilMmdd ?? null,
        taxableAgeFrom: 16,
        legalSource: r.legalSource
      }
    });
  }
}

async function seedProperty(spec: HotelSpec) {
  // 1) Property
  await prisma.property.upsert({
    where: { id: spec.id },
    create: {
      id: spec.id,
      organizationId: ORG_ID,
      name: spec.name,
      legalName: spec.legalName,
      address: spec.address,
      municipality: spec.municipality,
      province: spec.province,
      country: "ES",
      taxRegion: spec.taxRegion,
      timezone: spec.timezone,
      status: "open"
    },
    update: {
      name: spec.name,
      legalName: spec.legalName,
      address: spec.address,
      municipality: spec.municipality,
      province: spec.province,
      taxRegion: spec.taxRegion
    }
  });

  // 2) Room types + rooms
  let createdRoomTypeIds: string[] = [];
  for (const rt of spec.roomTypes) {
    const upserted = await prisma.roomType.upsert({
      where: { propertyId_code: { propertyId: spec.id, code: rt.code } } as never,
      create: {
        propertyId: spec.id,
        code: rt.code,
        name: rt.name,
        maxOccupancy: rt.maxOccupancy,
        baseCapacity: rt.baseCapacity,
        description: rt.bedConfig,
        defaultBedConfigurationJson: { layout: rt.bedConfig },
        active: true,
        sellable: true
      },
      update: {
        name: rt.name,
        maxOccupancy: rt.maxOccupancy,
        baseCapacity: rt.baseCapacity,
        description: rt.bedConfig
      }
    });
    createdRoomTypeIds.push(upserted.id);
  }

  // Build rooms — distribuir por floor desde planta 1 (lobby).
  // Cada room type ocupa sus propias plantas para evitar colisiones de numeración.
  const allRooms: Array<{ number: string; floor: number; roomTypeId: string }> = [];
  let floorCursor = 1;
  for (let i = 0; i < spec.roomTypes.length; i++) {
    const rt = spec.roomTypes[i];
    const roomTypeId = createdRoomTypeIds[i];
    const rooms = generateRoomNumbers(rt.qty, floorCursor);
    // Avanza el cursor a la siguiente planta para que el próximo room type no
    // comparta números con el actual (la upsert por (propertyId, number) sería
    // idempotente y "ganaría" el último, perdiendo habitaciones).
    floorCursor = Math.max(...rooms.map((r) => r.floor)) + 1;
    for (const r of rooms) allRooms.push({ ...r, roomTypeId });
  }
  for (const r of allRooms) {
    await prisma.room.upsert({
      where: { propertyId_number: { propertyId: spec.id, number: r.number } } as never,
      create: {
        propertyId: spec.id,
        roomTypeId: r.roomTypeId,
        number: r.number,
        floor: String(r.floor),
        status: "clean",
        sellable: true,
        active: true
      },
      update: { roomTypeId: r.roomTypeId, floor: String(r.floor) }
    });
  }

  // 3) Rate plans
  for (const rp of spec.ratePlans) {
    await prisma.ratePlan.upsert({
      where: { propertyId_code: { propertyId: spec.id, code: rp.code } } as never,
      create: {
        propertyId: spec.id,
        code: rp.code,
        name: rp.name,
        ratePlanType: rp.ratePlanType,
        mealPlan: rp.mealPlan,
        active: true
      },
      update: { name: rp.name, ratePlanType: rp.ratePlanType, mealPlan: rp.mealPlan }
    });
  }

  // 4) Stock locations (cocina + bar + bodega)
  const stockLocations = [
    { code: "loc_kitchen", name: "Cocina principal", type: "kitchen" },
    { code: "loc_bar", name: "Bar central", type: "bar" },
    { code: "loc_cellar", name: "Bodega", type: "cellar" },
    { code: "loc_warehouse", name: "Almacén general", type: "warehouse" }
  ];
  const locationIdByCode: Record<string, string> = {};
  for (const loc of stockLocations) {
    const existing = await prisma.stockLocation.findFirst({
      where: { propertyId: spec.id, name: loc.name }
    });
    if (existing) { locationIdByCode[loc.code] = existing.id; continue; }
    const created = await prisma.stockLocation.create({
      data: { propertyId: spec.id, name: loc.name, locationType: loc.type, active: true }
    });
    locationIdByCode[loc.code] = created.id;
  }

  // 5) Inventory items
  const invIdByCode: Record<string, string> = {};
  for (const inv of COMMON_INVENTORY) {
    // Verbose check first since (propertyId, sku) is not unique in the schema.
    const existing = await prisma.inventoryItem.findFirst({
      where: { propertyId: spec.id, sku: inv.code }
    });
    if (existing) { invIdByCode[inv.code] = existing.id; continue; }
    const created = await prisma.inventoryItem.create({
      data: {
        propertyId: spec.id,
        sku: inv.code,
        name: inv.name,
        category: inv.category,
        unit: inv.unit,
        unitCost: inv.unitCost,
        minLevel: inv.minLevel,
        active: true
      }
    });
    invIdByCode[inv.code] = created.id;
  }

  // 6) Menu items + recipes (escandallos) — outlets pueden variar por hotel.
  // Si BASE_MENU referencia un outletCode que no existe (p.ej. rest_main en
  // resorts con buffet/grill/asian), redirigimos al primer outlet del mismo
  // tipo para que TODOS los hoteles tengan una carta completa.
  const outletByCode = new Map(spec.outlets.map((o) => [o.code, o]));
  const firstRestaurant = spec.outlets.find((o) => o.type === "restaurant");
  const firstBar = spec.outlets.find((o) => o.type === "bar" || o.type === "pool_bar" || o.type === "rooftop");
  const resolveOutletCode = (wanted: string): string | null => {
    if (outletByCode.has(wanted)) return wanted;
    // BASE_MENU separa rest_main vs bar_lobby — usamos el tipo para redirigir.
    if (wanted.startsWith("rest_")) return firstRestaurant?.code ?? null;
    if (wanted.startsWith("bar_") || wanted.startsWith("pool_") || wanted.startsWith("spa_")) return firstBar?.code ?? null;
    return null;
  };
  for (const m of BASE_MENU) {
    const outletId = resolveOutletCode(m.outletCode);
    if (!outletId) continue;
    // Adjust price by hotel tier (luxury = +50%, boutique = +20%).
    const priceMultiplier =
      spec.category === "luxury" ? 1.6 :
      spec.category === "boutique" ? 1.25 :
      spec.category === "historic" ? 1.15 :
      spec.category === "business" ? 0.95 : 1;
    const adjustedPrice = Math.round(m.price * priceMultiplier * 100) / 100;
    const existingItem = await prisma.menuItem.findFirst({
      where: { propertyId: spec.id, outletId, name: m.name }
    });
    const menuItem = existingItem
      ? await prisma.menuItem.update({ where: { id: existingItem.id }, data: { price: adjustedPrice, sku: m.sku, category: m.category, taxRate: m.taxRate } })
      : await prisma.menuItem.create({
          data: {
            propertyId: spec.id,
            outletId,
            sku: m.sku,
            name: m.name,
            category: m.category,
            price: adjustedPrice,
            taxRate: m.taxRate,
            active: true
          }
        });
    // Recipes (escandallos): borra anteriores y crea nuevas para idempotencia.
    await prisma.menuRecipe.deleteMany({ where: { menuItemId: menuItem.id } });
    for (const r of m.recipe) {
      const invId = invIdByCode[r.inventoryCode];
      if (!invId) continue;
      await prisma.menuRecipe.create({
        data: { menuItemId: menuItem.id, inventoryItemId: invId, quantity: r.quantity }
      });
    }
  }

  // 7) Cancellation policy (1 por hotel: 48h gratis, después 1 noche penalización)
  const policyCode = `${spec.id}_std`;
  await prisma.cancellationPolicy.upsert({
    where: { propertyId_code: { propertyId: spec.id, code: policyCode } } as never,
    create: {
      propertyId: spec.id,
      code: policyCode,
      name: "Cancelación estándar 48h",
      description: "Cancelación gratuita hasta 48h antes de la llegada. Después, penalización de 1 noche. No-show penaliza la estancia completa.",
      freeCancelHours: 48,
      penaltyType: "first_night",
      noShowPenaltyType: "all_stay",
      active: true
    },
    update: {
      name: "Cancelación estándar 48h",
      description: "Cancelación gratuita hasta 48h antes de la llegada. Después, penalización de 1 noche. No-show penaliza la estancia completa.",
      freeCancelHours: 48,
      penaltyType: "first_night",
      noShowPenaltyType: "all_stay",
      active: true
    }
  });

  // Política flexible adicional (24h)
  const flexCode = `${spec.id}_flex`;
  await prisma.cancellationPolicy.upsert({
    where: { propertyId_code: { propertyId: spec.id, code: flexCode } } as never,
    create: {
      propertyId: spec.id,
      code: flexCode,
      name: "Cancelación flexible 24h",
      description: "Cancelación gratuita hasta 24h antes de la llegada.",
      freeCancelHours: 24,
      penaltyType: "first_night",
      noShowPenaltyType: "first_night",
      active: true
    },
    update: {
      name: "Cancelación flexible 24h",
      freeCancelHours: 24,
      penaltyType: "first_night",
      noShowPenaltyType: "first_night",
      active: true
    }
  });

  // Política no reembolsable (NRF)
  const nrfCode = `${spec.id}_nrf`;
  await prisma.cancellationPolicy.upsert({
    where: { propertyId_code: { propertyId: spec.id, code: nrfCode } } as never,
    create: {
      propertyId: spec.id,
      code: nrfCode,
      name: "No reembolsable",
      description: "Tarifa no reembolsable. Cancelación o no-show penaliza la estancia completa.",
      freeCancelHours: 0,
      penaltyType: "all_stay",
      noShowPenaltyType: "all_stay",
      active: true
    },
    update: {
      name: "No reembolsable",
      freeCancelHours: 0,
      penaltyType: "all_stay",
      noShowPenaltyType: "all_stay",
      active: true
    }
  });

  // 8) Allotments para hoteles resort (cuotas con tour operators)
  let allotmentsCreated = 0;
  if (spec.hasAllotments && createdRoomTypeIds.length > 0) {
    // Selecciona los dos primeros tour operators (TUI + Jet2) seedeados a nivel
    // organizativo en seedTourOperators(). Si no existen aún, los ignora.
    const operators = await prisma.tourOperator.findMany({
      where: { organizationId: ORG_ID, active: true },
      take: 2
    });
    const primaryRoomType = createdRoomTypeIds[0]; // Standard double = el típico contratado
    // Una temporada alta: jun 15 → sep 15 del año actual.
    const year = new Date().getUTCFullYear();
    const validFrom = new Date(`${year}-06-15`);
    const validTo = new Date(`${year}-09-15`);
    for (let opIdx = 0; opIdx < operators.length; opIdx++) {
      const op = operators[opIdx];
      const allotmentCode = `${spec.id}_${op.code}_summer`;
      const totalRooms = opIdx === 0 ? 25 : 15; // TUI más grande
      const allot = await prisma.allotment.upsert({
        where: { propertyId_code: { propertyId: spec.id, code: allotmentCode } } as never,
        create: {
          propertyId: spec.id,
          tourOperatorId: op.id,
          code: allotmentCode,
          name: `${op.name} · Verano ${year}`,
          roomTypeId: primaryRoomType,
          validFrom,
          validTo,
          totalRooms,
          releaseDays: 14,
          contractedRate: opIdx === 0 ? 95 : 110,
          currency: "EUR",
          status: "active",
          notes: `Cuota contratada con ${op.name} para temporada alta ${year}.`
        },
        update: {
          name: `${op.name} · Verano ${year}`,
          totalRooms,
          status: "active",
          contractedRate: opIdx === 0 ? 95 : 110
        }
      });
      // AllotmentDay: distribución plana (totalRooms cada día), con pickup
      // ya consumido en los primeros 7 días para que el dashboard muestre actividad.
      const dayCount = Math.min(45, Math.ceil((validTo.getTime() - validFrom.getTime()) / 86400000));
      // Borra días anteriores (re-genera limpio cada run).
      await prisma.allotmentDay.deleteMany({ where: { allotmentId: allot.id } });
      for (let d = 0; d < dayCount; d++) {
        const date = new Date(validFrom);
        date.setUTCDate(date.getUTCDate() + d);
        const pickup = d < 7 ? Math.min(totalRooms, Math.floor(totalRooms * 0.6)) : 0;
        await prisma.allotmentDay.create({
          data: {
            allotmentId: allot.id,
            date,
            blockedRooms: totalRooms,
            pickedUpRooms: pickup,
            releasedRooms: 0
          }
        });
      }
      allotmentsCreated++;
    }
  }

  return {
    propertyId: spec.id,
    roomTypes: createdRoomTypeIds.length,
    rooms: allRooms.length,
    allotments: allotmentsCreated
  };
}

// Main runner: seed each hotel
async function run() {
  console.log("[chain-seed] starting…");
  await ensureOrganization();
  await ensureTourOperators();
  await ensureTouristTaxRates();
  const results: Array<{ propertyId: string; roomTypes: number; rooms: number; allotments: number }> = [];
  for (const spec of HOTELS) {
    try {
      const r = await seedProperty(spec);
      results.push(r);
      console.log(`[chain-seed] ✓ ${spec.id} · ${r.rooms} rooms · ${r.roomTypes} types · ${r.allotments} allotments`);
    } catch (e) {
      console.error(`[chain-seed] ✗ ${spec.id}:`, e instanceof Error ? e.message : e);
    }
  }
  const totalRooms = results.reduce((s, r) => s + r.rooms, 0);
  const totalAllotments = results.reduce((s, r) => s + r.allotments, 0);
  console.log(`[chain-seed] done · ${results.length}/${HOTELS.length} hoteles · ${totalRooms} habitaciones · ${totalAllotments} allotments`);
  await prisma.$disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
