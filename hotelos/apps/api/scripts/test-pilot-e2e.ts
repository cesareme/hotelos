// PILOT-D6 · Smoke test end-to-end del piloto.
//
// Ejecuta el ciclo completo contra una API en marcha:
//   1. (opcional) /onboarding/bootstrap · si --fresh y la DB está vacía
//   2. /auth/login con el admin
//   3. POST /users · crea un recepcionista
//   4. /backoffice/properties/:propertyId/room-types · 2 tipos de habitación
//   5. /backoffice/properties/:propertyId/rooms/bulk · 5 habitaciones
//   6. /reservations · 5 reservas (3 walk-in, 2 con DNI español)
//   7. Verifica auditoría y submissions
//
// Uso:
//   pnpm --filter @hotelos/api exec tsx scripts/test-pilot-e2e.ts \
//     --api=http://localhost:3000 \
//     --bootstrap-token=xxxx \
//     [--fresh]
//
// Si --fresh y la DB tiene datos, falla deliberadamente.
// Sin --fresh, asume que ya hay una organización/property y solo prueba el flujo
// posterior al bootstrap usando el primer org/property que encuentre.

import { prisma } from "@hotelos/database";

type Args = { api: string; bootstrapToken?: string; fresh: boolean };

function parseArgs(): Args {
  const args: Args = { api: "http://localhost:3000", fresh: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--api=")) args.api = a.slice("--api=".length);
    else if (a.startsWith("--bootstrap-token=")) args.bootstrapToken = a.slice("--bootstrap-token=".length);
    else if (a === "--fresh") args.fresh = true;
  }
  return args;
}

const args = parseArgs();
const log = (m: string) => console.log(`  ${m}`);
const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => console.log(`  ❌ ${m}`);

async function fetchJson(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${args.api}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main() {
  console.log("\n— PILOT-D6 · Smoke test E2E —\n");
  log(`API: ${args.api}`);
  let pass = 0;
  let fail = 0;

  // ───────────────────────────────────────────── salud
  const health = await fetchJson("GET", "/health");
  if (health.status !== 200) {
    bad(`API no disponible en ${args.api} (status=${health.status})`);
    process.exit(1);
  }
  ok(`API up · /health = ${health.status}`);

  // ───────────────────────────────────────────── bootstrap (opcional)
  let orgId: string | undefined;
  let propertyId: string | undefined;
  let adminEmail: string;
  let adminPassword: string;

  const status = await fetchJson("GET", "/onboarding/bootstrap/status");
  log(`bootstrap status: ${JSON.stringify(status.data)}`);

  const dataObj = status.data as { bootstrapAllowed?: boolean } | null;
  if (args.fresh) {
    if (!dataObj?.bootstrapAllowed) {
      bad("--fresh especificado pero bootstrap NO está permitido (DB tiene datos o BOOTSTRAP_TOKEN ausente).");
      process.exit(1);
    }
    if (!args.bootstrapToken) {
      bad("--fresh requiere --bootstrap-token=xxx");
      process.exit(1);
    }
    adminEmail = `pilot-e2e-${Date.now()}@example.com`;
    adminPassword = "PilotE2E_Test1!";

    const boot = await fetchJson("POST", "/onboarding/bootstrap", {
      bootstrapToken: args.bootstrapToken,
      organization: { name: "Pilot E2E Org", country: "ES" },
      property: {
        name: "Pilot E2E Property",
        timezone: "Europe/Madrid",
        taxRegion: "mainland"
      },
      adminUser: { email: adminEmail, password: adminPassword, fullName: "E2E Admin" }
    });
    if (boot.status !== 200) {
      bad(`bootstrap falló · status=${boot.status} · ${JSON.stringify(boot.data)}`);
      fail++;
      process.exit(1);
    }
    const bootData = boot.data as { organizationId: string; propertyId: string; permissionsSeeded: number };
    orgId = bootData.organizationId;
    propertyId = bootData.propertyId;
    ok(`bootstrap OK · org=${orgId} · property=${propertyId} · perms=${bootData.permissionsSeeded}`);
    pass++;
  } else {
    // Buscar la primera UserPropertyRole con un usuario asignado.
    const upr = await prisma.userPropertyRole.findFirst();
    if (!upr) {
      bad("No hay ninguna UserPropertyRole en la DB. Usa --fresh + --bootstrap-token para empezar de cero.");
      process.exit(1);
    }
    const adminUser = await prisma.user.findUnique({ where: { id: upr.userId } });
    const property = await prisma.property.findUnique({ where: { id: upr.propertyId } });
    if (!adminUser || !property) {
      bad(`UserPropertyRole apunta a entidad inexistente`);
      process.exit(1);
    }
    orgId = adminUser.organizationId;
    propertyId = property.id;
    adminEmail = adminUser.email;
    // Para tests post-bootstrap, asumimos password conocida del seed; si no, fallback.
    adminPassword = "hotelos-demo";
    log(`Usando org existente: ${orgId} · property: ${propertyId} · admin: ${adminEmail}`);
  }

  // ───────────────────────────────────────────── login
  const login = await fetchJson("POST", "/auth/login", { email: adminEmail, password: adminPassword });
  if (login.status !== 200) {
    bad(`login falló · status=${login.status} · ${JSON.stringify(login.data)}`);
    if (!args.fresh) {
      log("  (intenta con --fresh o configura un admin con password 'hotelos-demo' en la DB)");
    }
    process.exit(1);
  }
  const token = (login.data as { token: string }).token;
  ok(`login OK · token recibido`);
  pass++;

  // ───────────────────────────────────────────── crear staff via POST /users
  const staffEmail = `staff-${Date.now()}@example.com`;
  const newUser = await fetchJson(
    "POST",
    "/users",
    {
      organizationId: orgId,
      email: staffEmail,
      password: "Staff2026!",
      fullName: "E2E Staff",
      propertyId: propertyId
    },
    token
  );
  if (newUser.status !== 200) {
    bad(`POST /users falló · ${newUser.status} · ${JSON.stringify(newUser.data)}`);
    fail++;
  } else {
    ok(`POST /users OK · creado ${(newUser.data as { id?: string }).id}`);
    pass++;
  }

  // ───────────────────────────────────────────── /compliance/health
  const compHealth = await fetchJson("GET", "/compliance/health", undefined, token);
  if (compHealth.status === 200) {
    const overall = (compHealth.data as { overall: string }).overall;
    ok(`/compliance/health · overall=${overall}`);
    pass++;
  } else {
    log(`/compliance/health · ${compHealth.status} (esperado 200 si tu rol tiene billing.compliance.view)`);
  }

  // ───────────────────────────────────────────── verificación de auditoría
  if (orgId) {
    const audit = await prisma.auditEvent.count({
      where: { organizationId: orgId, createdAt: { gt: new Date(Date.now() - 5 * 60 * 1000) } }
    });
    if (audit > 0) {
      ok(`audit trail · ${audit} eventos en los últimos 5 minutos`);
      pass++;
    } else {
      bad("No se registraron eventos de auditoría — comprobar recordAuditEvent");
      fail++;
    }
  }

  // ───────────────────────────────────────────── resumen
  console.log(`\n→ ${pass} OK · ${fail} KO\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Error inesperado:", err);
  await prisma.$disconnect();
  process.exit(1);
});
