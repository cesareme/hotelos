// PILOT-D4 smoke: invoca getComplianceHealth() y muestra el reporte.
// Ejecutar: pnpm --filter @hotelos/api exec tsx scripts/test-compliance-health.ts

import { prisma } from "@hotelos/database";
import { getComplianceHealth } from "../src/modules/compliance/compliance-health.service.js";

async function main() {
  const report = await getComplianceHealth();
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
