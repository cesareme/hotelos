// Seed the three canonical cancellation policies (Flexible / Semi-flex /
// Non-refundable — what every Spanish hotel uses) for one or several
// properties, and mark ONE of them as the property's default (Tanda L3 · lote B:
// `CancellationPolicy.isDefault`, the policy that rules the reservations
// without `cancellationPolicyId` / `cancellationPolicyCode`).
//
//   SEED_PROPERTY_ID=<id[,id,…]>   one property (default prop_123) or several
//                                  (csv) — the same variable, so no new entry in
//                                  the environment contract (scripts/env-contract.json).
//   The default policy is FLEX (DEFAULT_CODE below; the screen / PATCH can move it).
//
// Guarded by assertDemoTarget PER PROPERTY (Tanda 4 · DATA-05): a real hotel
// needs SEED_ALLOW_REAL=1 SEED_CONFIRM=<its id[,…]>. Idempotent: upsert by
// (propertyId, code); any other policy of the property that was the default
// is unmarked in the same transaction (at most one default per property).
// Faranda (8 centres, 2026-09-18):
//   SEED_ALLOW_REAL=1 SEED_CONFIRM=<8 ids> SEED_PROPERTY_ID=<8 ids> \
//     corepack pnpm --filter @hotelos/database db:seed:cancellation   → 24 rows, 8 defaults.
import { PrismaClient } from "@prisma/client";
import { assertDemoTarget } from "./lib/demo-guard.js";

const prisma = new PrismaClient();

const POLICIES = [
  { code: "FLEX", name: "Flexible", description: "Cancelación gratuita hasta 24 h antes de la llegada.", freeCancelHours: 24, penaltyType: "first_night", noShowPenaltyType: "first_night" },
  { code: "SEMI", name: "Semi-flexible", description: "Cancelación gratuita hasta 72 h antes; tras eso, primera noche.", freeCancelHours: 72, penaltyType: "first_night", noShowPenaltyType: "first_night" },
  { code: "NREF", name: "No reembolsable", description: "No admite cancelación; se cobra la estancia completa.", freeCancelHours: 0, penaltyType: "all_stay", noShowPenaltyType: "all_stay" }
] as const;

/** The property's default policy after the seed (one per property). */
const DEFAULT_CODE = "FLEX";

function targetPropertyIds(): string[] {
  const raw = process.env.SEED_PROPERTY_ID?.trim();
  if (!raw) return ["prop_123"];
  return Array.from(new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)));
}

async function seedProperty(propertyId: string): Promise<{ rows: number; defaults: number }> {
  assertDemoTarget({
    propertyId,
    action: "seed-cancellation-policies",
    planned: [
      { table: "cancellation_policies", op: "upsert", where: `property_id = ${propertyId} · code ∈ FLEX, SEMI, NREF`, count: POLICIES.length },
      { table: "cancellation_policies", op: "update", where: `property_id = ${propertyId} · is_default = true · code ≠ ${DEFAULT_CODE}` }
    ]
  });
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, name: true, code: true } });
  if (!property) throw new Error(`Property ${propertyId} not found`);
  console.log(`[cancel] property ${propertyId} (${property.code ?? "—"} · ${property.name})`);

  await prisma.$transaction(async (tx) => {
    for (const p of POLICIES) {
      const isDefault = p.code === DEFAULT_CODE;
      await tx.cancellationPolicy.upsert({
        where: { propertyId_code: { propertyId, code: p.code } },
        create: {
          propertyId, code: p.code, name: p.name, description: p.description,
          freeCancelHours: p.freeCancelHours, penaltyType: p.penaltyType, noShowPenaltyType: p.noShowPenaltyType,
          active: true, isDefault
        },
        update: {
          name: p.name, description: p.description,
          freeCancelHours: p.freeCancelHours, penaltyType: p.penaltyType, noShowPenaltyType: p.noShowPenaltyType,
          active: true, isDefault
        }
      });
    }
    // One default per property: unmark whatever else was the default.
    await tx.cancellationPolicy.updateMany({ where: { propertyId, isDefault: true, code: { not: DEFAULT_CODE } }, data: { isDefault: false } });
  });

  const [rows, defaults] = await Promise.all([
    prisma.cancellationPolicy.count({ where: { propertyId } }),
    prisma.cancellationPolicy.count({ where: { propertyId, isDefault: true } })
  ]);
  console.log(`[cancel]   ${rows} políticas (${POLICIES.map((p) => p.code).join("/")}), por defecto: ${DEFAULT_CODE} (${defaults}).`);
  return { rows, defaults };
}

async function main() {
  const propertyIds = targetPropertyIds();
  let totalRows = 0;
  let totalDefaults = 0;
  for (const propertyId of propertyIds) {
    const { rows, defaults } = await seedProperty(propertyId);
    totalRows += rows;
    totalDefaults += defaults;
  }
  console.log(`[cancel] ${propertyIds.length} propiedad(es): ${totalRows} filas en cancellation_policies, ${totalDefaults} por defecto.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
