// Demo RevenueDailySnapshot roll-ups so portfolio/owner KPIs (occupancy, ADR,
// RevPAR) come from the *official* snapshot path — not just the reservation
// fallback — and so every property in the org (incl. the smaller ones) shows
// realistic activity at scale.
//
// Also tops up room inventory for properties that were left with a single demo
// room, so occupancy weighting and RevPAR are meaningful.
//
// Idempotent: re-running rebuilds the DEMO top-level snapshots in the window
// (rows with dataSource "demo"; night_audit closes written by the API and any
// date that already has a top-level row are never touched) and only creates
// rooms for an allowlisted demo property that has none — and only when the
// operator opts in with SEED_CREATE_ROOMS=1. A property without rooms is
// skipped ("sin inventario") instead of receiving invented inventory.
//
// Guarded by assertDemoTarget (Tanda 4 · DATA-05): SEED_ORG_ID outside the demo
// allowlist needs SEED_ALLOW_REAL=1 + SEED_CONFIRM=<org id>.
//
// Run: node --env-file=../../.env --import tsx prisma/seed-revenue-snapshots.ts
import { PrismaClient } from "@prisma/client";
import { assertDemoTarget, isDemoProperty } from "./lib/demo-guard.js";

const prisma = new PrismaClient();
const ORGANIZATION_ID = process.env.SEED_ORG_ID ?? "org_123";
const HISTORY_DAYS = 430; // ~14 months so "same period last year" comparisons have data
const MS_DAY = 86_400_000;

function startUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Per-property demand/price profile. Matched by name keyword; generic fallback.
type Profile = { occ: number; adr: number; resort: boolean; rooms: number };
function profileFor(name: string): Profile {
  const n = name.toLowerCase();
  if (n.includes("tenerife") || n.includes("canary") || n.includes("canaria") || n.includes("mar")) {
    return { occ: 0.86, adr: 158, resort: true, rooms: 64 };
  }
  if (n.includes("bilbao") || n.includes("bizkaia")) {
    return { occ: 0.69, adr: 116, resort: false, rooms: 38 };
  }
  if (n.includes("madrid") || n.includes("centro")) {
    return { occ: 0.76, adr: 132, resort: false, rooms: 47 };
  }
  return { occ: 0.7, adr: 120, resort: false, rooms: 40 };
}

// Ensure a property has at least `target` active+sellable rooms. Creates a
// default room type if none sellable. Returns the active room count.
// Inventory is only ever CREATED for an allowlisted demo property that has no
// rooms at all, and only with SEED_CREATE_ROOMS=1 (DATA-05): a property that
// already has ≥1 room keeps its real inventory untouched.
async function ensureRooms(propertyId: string, target: number): Promise<number> {
  const current = await prisma.room.count({ where: { propertyId, active: true } });
  if (current >= target) return current;
  if (current >= 1 || !isDemoProperty(propertyId) || process.env.SEED_CREATE_ROOMS !== "1") return current;

  let roomType = await prisma.roomType.findFirst({ where: { propertyId, sellable: true, active: true } });
  if (!roomType) {
    roomType = await prisma.roomType.upsert({
      where: { propertyId_code: { propertyId, code: "DBL" } },
      create: { propertyId, code: "DBL", name: "Doble estándar", baseCapacity: 2, maxOccupancy: 2, sellable: true, active: true },
      update: { sellable: true, active: true }
    });
  }

  const existingNumbers = new Set(
    (await prisma.room.findMany({ where: { propertyId }, select: { number: true } })).map((r) => r.number)
  );
  for (let i = 1; existingNumbers.size < target && i <= target * 4; i += 1) {
    const floor = Math.floor((i - 1) / 20) + 1;
    const number = `${floor}${String(((i - 1) % 20) + 1).padStart(2, "0")}`;
    if (existingNumbers.has(number)) continue;
    await prisma.room
      .create({ data: { propertyId, number, roomTypeId: roomType.id, status: "clean", sellable: true, active: true } })
      .catch(() => undefined);
    existingNumbers.add(number);
  }
  return prisma.room.count({ where: { propertyId, active: true } });
}

async function seedProperty(property: { id: string; name: string }, today: Date) {
  const profile = profileFor(property.name);
  const roomsActive = await ensureRooms(property.id, profile.rooms);
  if (roomsActive === 0) {
    console.log(`[snapshots] ${property.name}: sin inventario (0 habitaciones activas) → omitida. Exporta SEED_CREATE_ROOMS=1 para crear ${profile.rooms} habitaciones demo.`);
    return;
  }
  const windowStart = addDays(today, -HISTORY_DAYS);

  const topLevel = { roomTypeId: null, ratePlanId: null, channelId: null, segment: null, market: null };
  // Idempotent: clear the DEMO top-level snapshots in the window before
  // re-inserting. night_audit closes (and any other dataSource) are kept.
  const removed = await prisma.revenueDailySnapshot.deleteMany({
    where: { propertyId: property.id, snapshotDate: { gte: windowStart, lte: today }, dataSource: "demo", ...topLevel }
  });
  // Dates that still have a top-level row (night_audit, imports) are skipped:
  // the unique index treats NULL dimensions as distinct, so createMany with
  // skipDuplicates would otherwise write a second row for the same day.
  const taken = new Set(
    (
      await prisma.revenueDailySnapshot.findMany({
        where: { propertyId: property.id, snapshotDate: { gte: windowStart, lte: today }, ...topLevel },
        select: { snapshotDate: true }
      })
    ).map((s) => s.snapshotDate.toISOString().slice(0, 10))
  );

  const rows: {
    propertyId: string;
    snapshotDate: Date;
    totalOcc: number;
    roomRevenue: number;
    totalRevenue: number;
    netRoomRevenue: number;
    grossOperatingProfit: number;
    adr: number;
    revpar: number;
    trevpar: number;
    goppar: number;
    occupancyPercent: number;
    dataSource: string;
  }[] = [];

  for (let i = 0; i <= HISTORY_DAYS; i += 1) {
    const date = addDays(windowStart, i);
    if (taken.has(date.toISOString().slice(0, 10))) continue;
    const dow = date.getUTCDay(); // 0 Sun .. 6 Sat
    const isWeekend = dow === 5 || dow === 6 || dow === 0;

    // Demand pattern: resorts peak on weekends, urban hotels mid-week.
    const dowOccAdj = profile.resort
      ? (isWeekend ? 0.1 : -0.04)
      : (dow >= 2 && dow <= 4 ? 0.07 : isWeekend ? -0.05 : 0);
    // Mild seasonal lift toward summer (peaks ~July/August).
    const month = date.getUTCMonth(); // 0..11
    const seasonal = 0.06 * Math.sin(((month - 3) / 12) * 2 * Math.PI);
    const noise = (Math.random() - 0.5) * 0.06;

    const occ = clamp(profile.occ + dowOccAdj + seasonal + noise, 0.35, 0.985);
    const roomsSold = Math.round(roomsActive * occ);
    const occupancyPercent = round2((roomsSold / Math.max(1, roomsActive)) * 100);

    const adrAdj = (profile.resort ? (isWeekend ? 0.12 : -0.02) : (dow >= 2 && dow <= 4 ? 0.05 : 0)) + (Math.random() - 0.5) * 0.05;
    const adr = round2(profile.adr * (1 + adrAdj));
    const roomRevenue = round2(roomsSold * adr);
    const totalRevenue = round2(roomRevenue * 1.28); // + F&B / extras
    const netRoomRevenue = round2(roomRevenue * 0.91); // net of ~9% commissions
    const grossOperatingProfit = round2(totalRevenue * 0.38); // ~38% GOP margin
    const revpar = round2(roomRevenue / Math.max(1, roomsActive));
    const trevpar = round2(totalRevenue / Math.max(1, roomsActive));
    const goppar = round2(grossOperatingProfit / Math.max(1, roomsActive));

    rows.push({
      propertyId: property.id,
      snapshotDate: date,
      totalOcc: roomsSold,
      roomRevenue,
      totalRevenue,
      netRoomRevenue,
      grossOperatingProfit,
      adr,
      revpar,
      trevpar,
      goppar,
      occupancyPercent,
      dataSource: "demo"
    });
  }

  await prisma.revenueDailySnapshot.createMany({ data: rows, skipDuplicates: true });
  console.log(`[snapshots] ${property.name}: ${roomsActive} rooms · ${rows.length} días sembrados (demo reemplazados ${removed.count}, ${taken.size} días con cierre real conservados)`);
}

async function main() {
  assertDemoTarget({
    orgId: ORGANIZATION_ID,
    action: "seed-revenue-snapshots",
    planned: [
      { table: "revenue_daily_snapshots", op: "deleteMany", where: `top-level · dataSource='demo' · ventana ${HISTORY_DAYS} días · todas las propiedades de la org` },
      { table: "rooms", op: "create", where: "solo propiedades demo con 0 habitaciones y SEED_CREATE_ROOMS=1" }
    ]
  });
  const today = startUtc();
  const properties = await prisma.property.findMany({
    where: { organizationId: ORGANIZATION_ID },
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  });
  if (properties.length === 0) throw new Error(`No properties found for org ${ORGANIZATION_ID}`);
  console.log(`[snapshots] org ${ORGANIZATION_ID} · ${properties.length} propiedades · ventana ${HISTORY_DAYS} días`);

  for (const property of properties) {
    await seedProperty(property, today);
  }
  console.log("[snapshots] listo.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
