// Seed B2B tour operators (Hotelbeds, TUI, FTI, JetTours) and a handful of
// active allotments for the demo property. Mirrors the canonical Spanish
// hotel commercial setup where 30–60% of inventory is sold via TT.OO.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ORG = process.env.SEED_ORG_ID ?? "org_123";
const PID = process.env.SEED_PROPERTY_ID ?? "prop_123";

const TOUR_OPERATORS = [
  { code: "HBED", name: "Hotelbeds", taxId: "B-57218257", contactEmail: "contracting@hotelbeds.com", defaultCommissionPct: 18, paymentTermsDays: 30 },
  { code: "TUI",  name: "TUI Group", taxId: "DE125634526", contactEmail: "contracting@tui.com", defaultCommissionPct: 22, paymentTermsDays: 45 },
  { code: "FTI",  name: "FTI Touristik", taxId: "DE131119820", contactEmail: "contracting@fti.de", defaultCommissionPct: 20, paymentTermsDays: 30 },
  { code: "JETT", name: "JetTours", taxId: "FR12380000000", contactEmail: "contracting@jettours.com", defaultCommissionPct: 17, paymentTermsDays: 30 }
];

async function main() {
  const property = await prisma.property.findUnique({ where: { id: PID }, select: { id: true, name: true } });
  if (!property) throw new Error(`Property ${PID} not found`);
  console.log(`[allotments] property ${PID} (${property.name})`);

  // Upsert tour operators at org level
  const toIds: Record<string, string> = {};
  for (const t of TOUR_OPERATORS) {
    const row = await prisma.tourOperator.upsert({
      where: { organizationId_code: { organizationId: ORG, code: t.code } },
      create: {
        organizationId: ORG, code: t.code, name: t.name, taxId: t.taxId, contactEmail: t.contactEmail,
        defaultCommissionPct: t.defaultCommissionPct, paymentTermsDays: t.paymentTermsDays, active: true
      },
      update: { name: t.name, taxId: t.taxId, contactEmail: t.contactEmail, defaultCommissionPct: t.defaultCommissionPct, paymentTermsDays: t.paymentTermsDays, active: true }
    });
    toIds[t.code] = row.id;
  }
  console.log(`[allotments] ${TOUR_OPERATORS.length} tour operators activos`);

  // Pick the first active room type for the property
  const roomType = await prisma.roomType.findFirst({ where: { propertyId: PID, active: true }, select: { id: true, code: true, name: true } });
  if (!roomType) throw new Error(`No active room types for property ${PID}`);
  console.log(`[allotments] usando room type ${roomType.code} (${roomType.name})`);

  // Wipe previous seeded allotments (id starts with "alot_seed_")
  const stale = await prisma.allotment.findMany({ where: { propertyId: PID, code: { startsWith: "SEED-" } }, select: { id: true } });
  if (stale.length > 0) {
    await prisma.allotmentDay.deleteMany({ where: { allotmentId: { in: stale.map((s) => s.id) } } });
    await prisma.allotment.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  // Create 3 active allotments: Hotelbeds (8 rooms / 6 months), TUI (5 rooms / Q3 peak), FTI (3 rooms / Q4)
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const addMonths = (m: number) => { const d = new Date(today); d.setUTCMonth(d.getUTCMonth() + m); return d; };
  const MS_DAY = 86_400_000;
  const definitions = [
    { code: "SEED-HBED-Q3", name: "Hotelbeds — Cuota Q3 (verano)", toCode: "HBED", roomQty: 8, from: addMonths(0), to: addMonths(6), releaseDays: 14, rate: 95 },
    { code: "SEED-TUI-PEAK", name: "TUI — Cupo agosto pico", toCode: "TUI", roomQty: 5, from: addMonths(2), to: addMonths(4), releaseDays: 21, rate: 110 },
    { code: "SEED-FTI-Q4", name: "FTI — Cuota otoño 2026", toCode: "FTI", roomQty: 3, from: addMonths(5), to: addMonths(9), releaseDays: 7, rate: 78 }
  ];

  for (const d of definitions) {
    const span = Math.round((d.to.getTime() - d.from.getTime()) / MS_DAY);
    const allotment = await prisma.allotment.create({
      data: {
        propertyId: PID, tourOperatorId: toIds[d.toCode], code: d.code, name: d.name,
        roomTypeId: roomType.id, validFrom: d.from, validTo: d.to,
        totalRooms: d.roomQty, releaseDays: d.releaseDays, contractedRate: d.rate,
        currency: "EUR", status: "active"
      }
    });
    // Materialize day rows with realistic pickup pattern
    const days = Array.from({ length: span }, (_, i) => {
      const date = new Date(d.from.getTime() + i * MS_DAY);
      // Demo pickup: 0-40% randomly consumed; near dates higher, far dates 0
      const daysFromNow = Math.round((date.getTime() - today.getTime()) / MS_DAY);
      const pickupRatio = daysFromNow < 14 ? 0.5 : daysFromNow < 60 ? 0.3 : daysFromNow < 120 ? 0.15 : 0;
      const picked = Math.min(d.roomQty, Math.floor(d.roomQty * pickupRatio * Math.random()));
      return { allotmentId: allotment.id, date, blockedRooms: d.roomQty, pickedUpRooms: picked };
    });
    await prisma.allotmentDay.createMany({ data: days });
    console.log(`[allotments]   · ${d.code}: ${days.length} días · ${d.roomQty} cuartos/día`);
  }
  console.log("[allotments] listo.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
