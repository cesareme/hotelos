// Rich Commercial/Revenue demo data so the figures look at hotel scale.
// Idempotent: re-running rebuilds the demo rate grid, demo reservations
// (code prefix RVNX-), comp-set snapshots, budgets, segments and pricing rules.
//
// Run: node --env-file=../../.env --import tsx prisma/seed-commercial-demo.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PROPERTY_ID = process.env.SEED_PROPERTY_ID ?? "prop_123";
const SELLABLE_TARGET = 48;
const MS_DAY = 86_400_000;

function startUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: Array<{ v: T; w: number }>): T {
  const total = arr.reduce((s, a) => s + a.w, 0);
  let r = Math.random() * total;
  for (const a of arr) { r -= a.w; if (r <= 0) return a.v; }
  return arr[arr.length - 1].v;
}

const NAMES = ["María López", "James Doyle", "Helena Park", "Carlos Ruiz", "Sophie Martin", "Globex Co", "Acme Tours", "Lucía Fernández", "Tom Becker", "Aisha Khan", "Marco Rossi", "Nina Petrova", "David Chen", "Elena Sanz", "Group Iberia"];
const SEGMENTS = [
  { v: "leisure", w: 38 },
  { v: "corporate", w: 24 },
  { v: "ota_leisure", w: 20 },
  { v: "group", w: 10 },
  { v: "wholesale", w: 8 }
];
const CHANNELS = [
  { v: "direct", w: 34 },
  { v: "booking.com", w: 30 },
  { v: "expedia", w: 16 },
  { v: "web", w: 12 },
  { v: "wholesaler", w: 8 }
];
const SEG_DISCOUNT: Record<string, number> = { leisure: 1.0, corporate: 0.9, ota_leisure: 1.0, group: 0.85, wholesale: 0.78 };

async function main() {
  const property = await prisma.property.findUnique({ where: { id: PROPERTY_ID } });
  if (!property) throw new Error(`Property ${PROPERTY_ID} not found`);
  console.log(`[seed] property ${PROPERTY_ID} (${property.name})`);

  // --- Room types: ensure exactly these 4 (cheapest → priciest), in order ---
  const TYPE_DEFS = [
    { code: "DBL", name: "Doble estándar", base: 2, max: 2, price: 105, weight: 0.45 },
    { code: "SUP", name: "Doble superior", base: 2, max: 3, price: 135, weight: 0.3 },
    { code: "JRS", name: "Junior suite", base: 2, max: 3, price: 175, weight: 0.16 },
    { code: "STE", name: "Suite", base: 2, max: 4, price: 230, weight: 0.09 }
  ];
  const roomTypes: { id: string; price: number; weight: number }[] = [];
  for (const d of TYPE_DEFS) {
    const rt = await prisma.roomType.upsert({
      where: { propertyId_code: { propertyId: PROPERTY_ID, code: d.code } },
      create: { propertyId: PROPERTY_ID, code: d.code, name: d.name, baseCapacity: d.base, maxOccupancy: d.max, sellable: true, active: true },
      update: { name: d.name, baseCapacity: d.base, maxOccupancy: d.max, sellable: true, active: true }
    });
    roomTypes.push({ id: rt.id, price: d.price, weight: d.weight });
  }
  // Retire any other (legacy) room types so the demo mix stays clean.
  const keepCodes = TYPE_DEFS.map((d) => d.code);
  await prisma.roomType.updateMany({ where: { propertyId: PROPERTY_ID, code: { notIn: keepCodes } }, data: { active: false, sellable: false } });

  const rtPrice = new Map<string, number>(roomTypes.map((rt) => [rt.id, rt.price]));

  // Weighted pool of room-type ids sized to SELLABLE_TARGET (DBL dominant).
  const typePool: string[] = [];
  roomTypes.forEach((rt, i) => {
    const n = i === roomTypes.length - 1 ? Math.max(0, SELLABLE_TARGET - typePool.length) : Math.round(SELLABLE_TARGET * rt.weight);
    for (let k = 0; k < n; k++) typePool.push(rt.id);
  });

  // --- Rooms: ensure SELLABLE_TARGET sellable rooms spread across types ---
  let rooms = await prisma.room.findMany({ where: { propertyId: PROPERTY_ID }, orderBy: { number: "asc" } });
  if (rooms.length < SELLABLE_TARGET) {
    const need = SELLABLE_TARGET - rooms.length;
    for (let i = 0; i < need; i++) {
      const rt = roomTypes[i % roomTypes.length];
      const number = `${100 + rooms.length + i + 1}`;
      await prisma.room.create({ data: { propertyId: PROPERTY_ID, number, roomTypeId: rt.id, status: "clean", sellable: true } }).catch(() => undefined);
    }
    rooms = await prisma.room.findMany({ where: { propertyId: PROPERTY_ID }, orderBy: { number: "asc" } });
  }
  // Mark first SELLABLE_TARGET sellable and assign their type from the weighted
  // pool (force-reassign so legacy single-type rooms get spread across the 4).
  let sellable = 0;
  for (const room of rooms) {
    const makeSellable = sellable < SELLABLE_TARGET;
    const rtId = makeSellable ? (typePool[sellable] ?? roomTypes[sellable % roomTypes.length].id) : (room.roomTypeId ?? roomTypes[0].id);
    await prisma.room.update({ where: { id: room.id }, data: { sellable: makeSellable, roomTypeId: rtId } });
    if (makeSellable) sellable++;
  }
  // Per-type sellable distribution (round-robin from above keeps it even).
  const sellableRooms = await prisma.room.findMany({ where: { propertyId: PROPERTY_ID, sellable: true }, select: { roomTypeId: true } });
  const typeCap = new Map<string, number>();
  for (const r of sellableRooms) if (r.roomTypeId) typeCap.set(r.roomTypeId, (typeCap.get(r.roomTypeId) ?? 0) + 1);
  console.log(`[seed] sellable rooms: ${sellableRooms.length}`);

  // --- BAR rate plan ---
  const bar = await prisma.ratePlan.upsert({
    where: { propertyId_code: { propertyId: PROPERTY_ID, code: "BAR" } },
    create: { propertyId: PROPERTY_ID, code: "BAR", name: "Best Available Rate", ratePlanType: "public", mealPlan: "BB", active: true },
    update: {}
  });

  const today = startUtc();
  const gridFrom = addDays(today, -45);
  const gridTo = addDays(today, 120);

  // --- Rate grid (RateDay) ---
  await prisma.rateDay.deleteMany({ where: { propertyId: PROPERTY_ID, ratePlanId: bar.id, date: { gte: gridFrom, lte: gridTo } } });
  const rateRows: { propertyId: string; ratePlanId: string; roomTypeId: string; date: Date; price: number; currency: string }[] = [];
  const priceFor = (rtId: string, d: Date): number => {
    const base = rtPrice.get(rtId) ?? 130;
    const dow = d.getUTCDay();
    const weekend = dow === 5 || dow === 6 ? 1.18 : dow === 0 ? 1.05 : 1.0;
    const month = d.getUTCMonth();
    const season = month >= 5 && month <= 8 ? 1.16 : month === 11 || month === 0 ? 0.92 : 1.0;
    return Math.round(base * weekend * season);
  };
  for (let d = new Date(gridFrom); d <= gridTo; d = addDays(d, 1)) {
    for (const rt of roomTypes) rateRows.push({ propertyId: PROPERTY_ID, ratePlanId: bar.id, roomTypeId: rt.id, date: new Date(d), price: priceFor(rt.id, d), currency: "EUR" });
  }
  for (let i = 0; i < rateRows.length; i += 1000) await prisma.rateDay.createMany({ data: rateRows.slice(i, i + 1000) });
  console.log(`[seed] rate days: ${rateRows.length}`);

  // --- Reservations ---
  await prisma.reservation.deleteMany({ where: { propertyId: PROPERTY_ID, code: { startsWith: "RVNX-" } } });
  const resFrom = addDays(today, -30);
  const resTo = addDays(today, 90);
  const occByDate = new Map<string, number>();
  const losDist = [{ v: 1, w: 28 }, { v: 2, w: 30 }, { v: 3, w: 22 }, { v: 4, w: 12 }, { v: 5, w: 8 }];
  const typeIds = roomTypes.map((rt) => rt.id);
  const reservations: Record<string, unknown>[] = [];
  let seq = 0;
  for (let a = new Date(resFrom); a <= resTo; a = addDays(a, 1)) {
    const dow = a.getUTCDay();
    const weekendFactor = dow === 4 || dow === 5 ? 1.25 : dow === 6 ? 1.1 : 1.0;
    const arrivals = Math.round(sellableRooms.length * 0.3 * weekendFactor);
    for (let k = 0; k < arrivals; k++) {
      const los = pick(losDist);
      const dep = addDays(a, los);
      // capacity check across nights
      let ok = true;
      for (let i = 0; i < los; i++) { const key = iso(addDays(a, i)); if ((occByDate.get(key) ?? 0) >= sellableRooms.length) { ok = false; break; } }
      if (!ok) continue;
      const rtId = typePool[rand(0, typePool.length - 1)];
      const segment = pick(SEGMENTS);
      const channel = pick(CHANNELS);
      const disc = SEG_DISCOUNT[segment] ?? 1;
      let total = 0;
      for (let i = 0; i < los; i++) total += priceFor(rtId, addDays(a, i)) * disc;
      total = Math.round(total);
      // status
      let status = "confirmed";
      const roll = Math.random();
      if (dep <= today) status = roll < 0.03 ? "no_show" : roll < 0.07 ? "cancelled" : "checked_out";
      else if (a <= today && dep > today) status = "checked_in";
      else status = roll < 0.05 ? "cancelled" : "confirmed";
      // createdAt (booking lead time)
      const lead = segment === "group" ? rand(20, 90) : segment === "corporate" ? rand(3, 40) : rand(0, 35);
      let createdAt = addDays(a, -lead);
      if (createdAt.getTime() > today.getTime()) createdAt = addDays(today, -rand(0, 21));
      // count occupancy only for OTB statuses
      if (status === "confirmed" || status === "checked_in" || status === "checked_out") {
        for (let i = 0; i < los; i++) { const key = iso(addDays(a, i)); occByDate.set(key, (occByDate.get(key) ?? 0) + 1); }
      }
      seq++;
      reservations.push({
        propertyId: PROPERTY_ID,
        code: `RVNX-${String(seq).padStart(5, "0")}`,
        channel,
        status,
        arrivalDate: new Date(a),
        departureDate: dep,
        adults: rand(1, 2),
        children: Math.random() < 0.25 ? rand(1, 2) : 0,
        roomsCount: 1,
        roomTypeId: rtId,
        marketSegment: segment,
        sourceCode: channel,
        bookerName: NAMES[rand(0, NAMES.length - 1)],
        totalAmount: total,
        currency: "EUR",
        createdAt
      });
    }
  }
  for (let i = 0; i < reservations.length; i += 1000) await prisma.reservation.createMany({ data: reservations.slice(i, i + 1000) as never });
  console.log(`[seed] reservations: ${reservations.length}`);

  // --- Forecasts (deterministic, per room type) so forecast/accuracy/segment/
  //     meeting-pack/budget-projection are fresh without an API call ---
  const fcTo = addDays(today, 90);
  await prisma.revenueForecast.deleteMany({ where: { propertyId: PROPERTY_ID, forecastDate: { gte: today, lte: fcTo } } });
  const fcRows: Record<string, unknown>[] = [];
  for (let d = new Date(today); d <= fcTo; d = addDays(d, 1)) {
    const dow = d.getUTCDay();
    const bump = dow === 5 || dow === 6 ? 0.18 : dow === 0 ? 0.05 : 0;
    const occ = Math.max(0.2, Math.min(0.98, 0.68 + bump));
    for (const rt of roomTypes) {
      const total = typeCap.get(rt.id) ?? 0;
      const adr = priceFor(rt.id, d);
      const roomsSold = Math.round(total * occ);
      const roomRevenue = Math.round(roomsSold * adr * 100) / 100;
      const revpar = total > 0 ? Math.round((roomRevenue / total) * 100) / 100 : 0;
      fcRows.push({
        propertyId: PROPERTY_ID,
        forecastDate: new Date(d),
        roomTypeId: rt.id,
        expectedOccupancy: Math.round(occ * 10000) / 100,
        expectedRoomsSold: roomsSold,
        expectedAdr: adr,
        expectedRevpar: revpar,
        expectedRoomRevenue: roomRevenue,
        expectedTotalRevenue: roomRevenue,
        confidence: 60,
        modelVersion: "deterministic-v1",
        driversJson: [{ driver: "base_occupancy", value: 0.68 }, { driver: "weekend_bump", value: bump }]
      });
    }
  }
  for (let i = 0; i < fcRows.length; i += 1000) await prisma.revenueForecast.createMany({ data: fcRows.slice(i, i + 1000) as never });
  console.log(`[seed] forecasts: ${fcRows.length}`);

  // --- Competitors + comp-set snapshots ---
  await prisma.competitorRateSnapshot.deleteMany({ where: { propertyId: PROPERTY_ID, shopDate: today } });
  await prisma.competitorHotel.deleteMany({ where: { propertyId: PROPERTY_ID } });
  const comps = [
    { name: "Catalonia Centro", category: "4*", score: 0.9, offset: -0.04 },
    { name: "Eurostars Plaza", category: "4*", score: 0.85, offset: 0.06 },
    { name: "NH Collection Gran Vía", category: "5*", score: 0.8, offset: 0.14 }
  ];
  const compRows: Record<string, unknown>[] = [];
  for (const c of comps) {
    const comp = await prisma.competitorHotel.create({ data: { propertyId: PROPERTY_ID, name: c.name, category: c.category, comparableScore: c.score, active: true } });
    for (let i = 0; i < 30; i++) {
      const stay = addDays(today, i);
      const anchor = priceFor(typeIds[0], stay);
      compRows.push({ propertyId: PROPERTY_ID, competitorHotelId: comp.id, sourceChannel: "demo", shopDate: today, stayDate: stay, roomTypeLabel: "Doble estándar", ratePlanLabel: "BAR", price: Math.round(anchor * (1 + c.offset)), currency: "EUR", availabilityStatus: "available" });
    }
  }
  await prisma.competitorRateSnapshot.createMany({ data: compRows as never });
  console.log(`[seed] competitors: ${comps.length}, comp rates: ${compRows.length}`);

  // --- Budgets (current + next 2 months) ---
  const avgAdr = 150;
  for (let m = 0; m < 3; m++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + m, 1));
    const periodMonth = iso(d).slice(0, 7);
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const occ = 0.7;
    const roomsSold = Math.round(sellableRooms.length * days * occ);
    await prisma.budget.upsert({
      where: { propertyId_periodMonth: { propertyId: PROPERTY_ID, periodMonth } },
      create: { propertyId: PROPERTY_ID, periodMonth, budgetedRoomsSold: roomsSold, budgetedOccupancy: occ * 100, budgetedAdr: avgAdr, budgetedRoomRevenue: Math.round(roomsSold * avgAdr) },
      update: { budgetedRoomsSold: roomsSold, budgetedOccupancy: occ * 100, budgetedAdr: avgAdr, budgetedRoomRevenue: Math.round(roomsSold * avgAdr) }
    });
  }
  console.log("[seed] budgets: 3 months");

  // --- Market segments ---
  const segDefs = [
    { code: "leisure", name: "Ocio", category: "transient" },
    { code: "corporate", name: "Corporativo", category: "corporate" },
    { code: "ota_leisure", name: "OTA ocio", category: "transient" },
    { code: "group", name: "Grupos", category: "group" },
    { code: "wholesale", name: "Turoperador", category: "wholesale" },
    { code: "direct_web", name: "Directo web", category: "transient" }
  ];
  for (let i = 0; i < segDefs.length; i++) {
    const s = segDefs[i];
    await prisma.marketSegment.upsert({
      where: { propertyId_code: { propertyId: PROPERTY_ID, code: s.code } },
      create: { propertyId: PROPERTY_ID, code: s.code, name: s.name, category: s.category, sortOrder: i * 10 },
      update: { name: s.name, category: s.category }
    });
  }
  console.log("[seed] market segments: 6");

  // --- Pricing rules (so recommendations look real) ---
  if ((await prisma.pricingRule.count({ where: { propertyId: PROPERTY_ID } })) === 0) {
    await prisma.pricingRule.createMany({
      data: [
        { propertyId: PROPERTY_ID, name: "Demanda muy alta +12%", priority: 10, minOccupancy: 80, adjustType: "percent", adjustValue: 12 },
        { propertyId: PROPERTY_ID, name: "Demanda alta +6%", priority: 20, minOccupancy: 65, maxOccupancy: 80, adjustType: "percent", adjustValue: 6 },
        { propertyId: PROPERTY_ID, name: "Demanda baja -8%", priority: 30, minOccupancy: 0, maxOccupancy: 40, adjustType: "percent", adjustValue: -8 }
      ]
    });
    console.log("[seed] pricing rules: 3");
  }

  // --- BAR recommendations (OTB + comp-set + rules), so the screen is populated ---
  const recFrom = today;
  const recTo = addDays(today, 30);
  await prisma.revenueRecommendation.deleteMany({ where: { propertyId: PROPERTY_ID, recommendationType: "bar", status: "pending", targetDate: { gte: recFrom, lte: recTo } } });
  const rules = await prisma.pricingRule.findMany({ where: { propertyId: PROPERTY_ID, active: true }, orderBy: { priority: "asc" } });
  const dec = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const compOffsets = comps.map((c) => c.offset);
  const recRows: Record<string, unknown>[] = [];
  for (let d = new Date(recFrom); d <= recTo; d = addDays(d, 1)) {
    const key = iso(d);
    const occ = sellableRooms.length > 0 ? Math.round(((occByDate.get(key) ?? 0) / sellableRooms.length) * 10000) / 100 : 0;
    const baseBar = priceFor(typeIds[0], d); // cheapest type = BAR anchor
    const compPrices = compOffsets.map((o) => Math.round(baseBar * (1 + o))).sort((a, b) => a - b);
    const compMedian = compPrices.length ? compPrices[Math.floor(compPrices.length / 2)] : null;
    const rule = rules.find((r) => {
      const lo = r.minOccupancy === null ? -Infinity : Number(r.minOccupancy);
      const hi = r.maxOccupancy === null ? Infinity : Number(r.maxOccupancy);
      return occ >= lo && occ <= hi;
    });
    const reasons: Array<{ driver: string; value: unknown }> = [{ driver: "occupancy_pct", value: occ }, { driver: "current_bar", value: baseBar }];
    if (compMedian !== null) reasons.push({ driver: "compset_median", value: compMedian });
    let recommended = baseBar;
    if (rule) {
      recommended = rule.adjustType === "amount" ? baseBar + Number(rule.adjustValue) : baseBar * (1 + Number(rule.adjustValue) / 100);
      const mn = dec(rule.minPrice);
      const mx = dec(rule.maxPrice);
      if (mn !== null) recommended = Math.max(recommended, mn);
      if (mx !== null) recommended = Math.min(recommended, mx);
      reasons.push({ driver: "rule", value: rule.name });
    } else if (compMedian !== null) {
      recommended = baseBar + (compMedian - baseBar) * 0.3;
      reasons.push({ driver: "rule", value: "comp_set_tracking" });
    }
    recommended = Math.round(Math.max(40, recommended) * 100) / 100;
    const deltaPct = baseBar > 0 ? Math.abs((recommended - baseBar) / baseBar) * 100 : 0;
    if (deltaPct < 1) continue;
    recRows.push({
      propertyId: PROPERTY_ID,
      recommendationType: "bar",
      targetDate: new Date(d),
      currentValueJson: { bar: baseBar, occupancyPct: occ, compsetMedian: compMedian },
      recommendedValueJson: { bar: recommended },
      expectedImpactJson: { direction: recommended > baseBar ? "up" : "down", deltaPct: Math.round(((recommended - baseBar) / baseBar) * 10000) / 100 },
      reasonJson: reasons,
      confidence: 60,
      riskLevel: deltaPct > 15 ? "high" : "medium",
      status: "pending"
    });
  }
  if (recRows.length) await prisma.revenueRecommendation.createMany({ data: recRows as never });
  console.log(`[seed] recommendations: ${recRows.length}`);

  console.log("[seed] done.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
