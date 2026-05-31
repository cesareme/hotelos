// PILOT-D3 smoke: prueba en proceso los cerrojos del bootstrap.
//
// Verifica:
//   1. isBootstrapAllowed() devuelve allowed:false cuando ya hay organizaciones.
//   2. bootstrapPilot() rechaza si BOOTSTRAP_TOKEN no está configurado.
//   3. bootstrapPilot() rechaza si el token no coincide.
//   4. bootstrapPilot() rechaza si ya existe una organización (guard #2).
//
// Ejecutar: pnpm --filter @hotelos/api exec tsx scripts/test-bootstrap-guards.ts

import { prisma } from "@hotelos/database";
import { isBootstrapAllowed, bootstrapPilot } from "../src/modules/onboarding/bootstrap.service.js";

async function expectError(label: string, fn: () => Promise<unknown>, expectedSubstring: string): Promise<boolean> {
  try {
    await fn();
    console.log(`  ❌ ${label} — no se lanzó error (esperado: ${expectedSubstring})`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedSubstring)) {
      console.log(`  ✅ ${label}: ${msg}`);
      return true;
    }
    console.log(`  ❌ ${label} — error inesperado: ${msg}`);
    return false;
  }
}

async function main() {
  console.log("\n— PILOT-D3 · Bootstrap guards smoke —\n");

  // Snapshot del estado actual
  const orgCount = await prisma.organization.count();
  console.log(`DB tiene ${orgCount} organizaciones.`);

  // 1) Status público
  const status = await isBootstrapAllowed();
  console.log(`\n[1] isBootstrapAllowed():`, status);
  if (orgCount > 0 && status.allowed) {
    console.log("  ❌ Esperaba allowed:false con organizaciones presentes.");
    process.exit(1);
  }
  console.log("  ✅ status correctamente refleja el estado.");

  // 2) Sin BOOTSTRAP_TOKEN en env
  const originalToken = process.env.BOOTSTRAP_TOKEN;
  delete process.env.BOOTSTRAP_TOKEN;
  let passed = 0;
  let total = 0;
  total += 1;
  if (
    await expectError(
      "[2] Sin BOOTSTRAP_TOKEN env",
      () =>
        bootstrapPilot({
          bootstrapToken: "whatever",
          organization: { name: "Test" },
          property: { name: "Test Property" },
          adminUser: { email: "test@test.com", password: "Test1234!", fullName: "Test" }
        }),
      "BOOTSTRAP_TOKEN no configurado"
    )
  ) {
    passed += 1;
  }

  // 3) Token no coincide
  process.env.BOOTSTRAP_TOKEN = "secret-correct-token-1234";
  total += 1;
  if (
    await expectError(
      "[3] Token erróneo",
      () =>
        bootstrapPilot({
          bootstrapToken: "wrong-token",
          organization: { name: "Test" },
          property: { name: "Test Property" },
          adminUser: { email: "test@test.com", password: "Test1234!", fullName: "Test" }
        }),
      "Token de bootstrap inválido"
    )
  ) {
    passed += 1;
  }

  // 4) Token correcto pero DB ya tiene org (sólo si hay orgs)
  if (orgCount > 0) {
    total += 1;
    if (
      await expectError(
        "[4] DB ya inicializada",
        () =>
          bootstrapPilot({
            bootstrapToken: "secret-correct-token-1234",
            organization: { name: "Test" },
            property: { name: "Test Property" },
            adminUser: { email: "test@test.com", password: "Test1234!", fullName: "Test" }
          }),
        "Bootstrap ya ejecutado"
      )
    ) {
      passed += 1;
    }
  }

  // 5) Validación de input — password débil
  total += 1;
  if (
    await expectError(
      "[5] Password débil",
      () =>
        bootstrapPilot({
          bootstrapToken: "secret-correct-token-1234",
          organization: { name: "Test" },
          property: { name: "Test Property" },
          adminUser: { email: "test@test.com", password: "weak", fullName: "Test" }
        }),
      // Si la DB tiene orgs, este caso lanza primero el guard de count.
      // Comprobamos cualquiera de los dos errores aceptables.
      orgCount > 0 ? "Bootstrap ya ejecutado" : "Contraseña no válida"
    )
  ) {
    passed += 1;
  }

  // Restaurar env
  if (originalToken !== undefined) process.env.BOOTSTRAP_TOKEN = originalToken;
  else delete process.env.BOOTSTRAP_TOKEN;

  console.log(`\n→ ${passed}/${total} casos pasaron.\n`);
  await prisma.$disconnect();
  process.exit(passed === total ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Error inesperado:", err);
  await prisma.$disconnect();
  process.exit(1);
});
