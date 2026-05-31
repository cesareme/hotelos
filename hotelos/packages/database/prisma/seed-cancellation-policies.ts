// Seed three canonical cancellation policies for the demo property — they
// mirror what every Spanish hotel uses (Flexible / Semi-flex / Non-refundable)
// and are referenced by Reservation.cancellationPolicyCode.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PID = process.env.SEED_PROPERTY_ID ?? "prop_123";

const POLICIES = [
  { code: "FLEX", name: "Flexible", description: "Cancelación gratuita hasta 24 h antes de la llegada.", freeCancelHours: 24, penaltyType: "first_night", noShowPenaltyType: "first_night" },
  { code: "SEMI", name: "Semi-flexible", description: "Cancelación gratuita hasta 72 h antes; tras eso, primera noche.", freeCancelHours: 72, penaltyType: "first_night", noShowPenaltyType: "first_night" },
  { code: "NREF", name: "No reembolsable", description: "No admite cancelación; se cobra la estancia completa.", freeCancelHours: 0, penaltyType: "all_stay", noShowPenaltyType: "all_stay" }
];

async function main() {
  const property = await prisma.property.findUnique({ where: { id: PID }, select: { id: true, name: true } });
  if (!property) throw new Error(`Property ${PID} not found`);
  console.log(`[cancel] property ${PID} (${property.name})`);
  for (const p of POLICIES) {
    await prisma.cancellationPolicy.upsert({
      where: { propertyId_code: { propertyId: PID, code: p.code } },
      create: {
        propertyId: PID, code: p.code, name: p.name, description: p.description,
        freeCancelHours: p.freeCancelHours, penaltyType: p.penaltyType, noShowPenaltyType: p.noShowPenaltyType,
        active: true
      },
      update: {
        name: p.name, description: p.description,
        freeCancelHours: p.freeCancelHours, penaltyType: p.penaltyType, noShowPenaltyType: p.noShowPenaltyType,
        active: true
      }
    });
  }
  console.log(`[cancel] ${POLICIES.length} políticas activas para ${PID}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
