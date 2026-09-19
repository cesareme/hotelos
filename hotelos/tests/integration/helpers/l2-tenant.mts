/**
 * Tanda L2 · helper de tenant AISLADO para los tests de integración L2-02 … L2-08
 * (lote L2-01). No es un test: el glob `tests/integration/*.test.mts` no lo
 * ejecuta; los tests lo importan.
 *
 *   const { createIsolatedTenant, enableModules, login, cleanupTenant, STRICT_ENV, withEnv, farandaInvariants } =
 *     await import("./helpers/l2-tenant.mts");
 *
 * Qué da:
 *   · createIsolatedTenant(run) → organización `org_l2_<run>` + sociedad (NIF con
 *     checksum válido derivado del run) + dos hoteles A y B (tipo DBL, 3
 *     habitaciones, plan BAR con tarifas publicadas 2026-10-01…10-07), plan
 *     contable PGC provisionado, catálogo de permisos sincronizado, roles de
 *     plantilla (`provisionDefaultTemplateRoles` + «Administración de sistema»
 *     para `systems`), usuarios `<rol>.l2.<run>@faranda.test` con contraseña
 *     fija (`tenant.password`) y asignaciones REALES (user_role_assignments):
 *     owner → organización · general_manager → A y B (ámbito hotel, dos filas) ·
 *     receptionist → solo A · accountant → organización · systems (admin) →
 *     organización. Llama a resetRbacScopeCacheForTests() al terminar.
 *   · enableModules(propertyId, codes) → filas property_modules `enabled` +
 *     hydrateTenantMirrors(): sin ello el gating síncrono del motor
 *     (requireAdvancedModuleEnabled → getEnabledModuleCodes lee el espejo
 *     demoStore.propertyModules hidratado al arrancar) responde 403 para una
 *     propiedad nueva. OJO (HEAD, hasta L2-02): listAdvancedRecords evalúa
 *     EAGER el informe de revenue (advanced-modules.service.ts:1233-1237), así
 *     que cualquier lista del motor exige además `revenue_profit_engine`:
 *     enableModules(A, ["workforce_labor", "revenue_profit_engine"]).
 *   · login(app, email, password) → POST /auth/login real (cada login desde una IP
 *     loopback distinta: el límite anti-fuerza-bruta es 10/min por IP).
 *   · STRICT_ENV + withEnv(overrides, run) → auth real, sin unión de permisos de
 *     demo, RBAC_STRICT=true (copia de api-integration.test.mts:47-55).
 *   · cleanupTenant(orgId) → flushAuditQueues() + borrado ordenado de TODO lo que
 *     cuelga de la organización (cadena explícita de structure-e2e/rbac-sod +
 *     barrido genérico por columnas organizationId/propertyId/userId/roleId sobre
 *     el DMMF del cliente Prisma, así cubre también las tablas que L2-02…L2-08
 *     añadan) hasta organization.deleteMany. Nunca toca nada fuera de su org.
 *   · farandaInvariants() → cifras de Faranda (cmrhw9jy30002fyvb6tsdiugt) para
 *     comparar antes/después: FARANDA_EXPECTED_INVARIANTS.
 *
 * Nunca crea nada fuera de su organización; ni org_123 ni Faranda se escriben.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // Sin .env → valores de CI.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
// Corrector L2 (L2R-FC-03): la puerta completa lanza los 46 ficheros de
// tests/integration en procesos paralelos (availableParallelism − 1) y cada uno
// abre su pool de Prisma (por defecto 2·CPU + 1 = 25 conexiones en el Mac Pro);
// con max_connections = 100 en Postgres las 12 suites L2 agotaban las conexiones
// (P2037 «too many clients already» en ledger-import y l2-robustez). Las
// suites que importan este helper limitan su pool (Prisma lo lee de la URL);
// una URL que ya fija connection_limit no se toca.
const L2_POOL_LIMIT = process.env.L2_TEST_CONNECTION_LIMIT ?? "4";
if (!/[?&]connection_limit=/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL += `${process.env.DATABASE_URL.includes("?") ? "&" : "?"}connection_limit=${L2_POOL_LIMIT}`;
}
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

// Imports dinámicos tras fijar el entorno (misma razón que rbac-sod.test.mts:48-53).
const { prisma, hashPassword } = await import("@hotelos/database");
const { ROLE_TEMPLATE_LABELS_ES } = await import("@hotelos/shared");
const { syncPermissionCatalog, provisionDefaultTemplateRoles, applyRoleTemplate, templateRoleMetadata } = await import(
  "../../../apps/api/src/lib/rbac-catalog.js"
);
const { provisionOrganizationChart } = await import("../../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { flushAuditQueues } = await import("../../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../../apps/api/src/lib/rbac-scope.js");
const { resetRbacStrictModeForTests } = await import("../../../apps/api/src/security/route-permissions.js");
const { hydrateTenantMirrors } = await import("../../../apps/api/src/lib/tenant-hydration.js");

import type { buildApiServer } from "../../../apps/api/src/server.js";
import type { HotelModuleCode } from "@hotelos/product";

export type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
export type Headers = Record<string, string>;
export type Session = { token: string; headers: Headers; userId: string; email: string };

export type TenantUserKey = "owner" | "generalManager" | "receptionist" | "accountant" | "systems";
export type TenantUser = { id: string; email: string; fullName: string; templateKey: string };

export type IsolatedTenant = {
  run: string;
  organizationId: string;
  legalEntityId: string;
  taxId: string;
  /** Hotel A: todos los usuarios lo ven. */
  propertyA: string;
  /** Hotel B: solo owner, general_manager, accountant y systems. */
  propertyB: string;
  roomTypeA: string;
  roomTypeB: string;
  ratePlanA: string;
  ratePlanB: string;
  roomsA: string[];
  roomsB: string[];
  /** Contraseña común de los cinco usuarios. */
  password: string;
  users: Record<TenantUserKey, TenantUser>;
  /** templateKey → role id (los 22 de organización + admin). */
  roles: Record<string, string>;
};

export const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";

/** Cifras de Faranda verificadas el 2026-09-18 (psql) — deben ser idénticas antes y después de cada suite. */
export const FARANDA_EXPECTED_INVARIANTS = {
  invoices: 25,
  verifactuSubmissions: 33,
  journalEntries: 4951,
  ledgerImports: 34,
  reservations: 110
} as const;

export type FarandaInvariants = { [K in keyof typeof FARANDA_EXPECTED_INVARIANTS]: number };

export const STRICT_ENV: Record<string, string> = {
  HOTELOS_ALLOW_DEMO_AUTH: "false",
  NODE_ENV: "production",
  HOTELOS_DEMO_PERMISSION_UNION: "false",
  RBAC_STRICT: "true"
};

const PASSWORD = "L2-Tenant-2026!";
const RATE_DAYS = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];

function applyEnv(entries: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * `undefined` retira la variable mientras dura `run`. El modo estricto de RBAC se
 * memoriza en el primer uso (route-permissions.ts); se descarta al entrar y al
 * salir para que el override valga sobre un servidor ya arrancado y no se cuele
 * en el test siguiente (copia de api-integration.test.mts:47-55).
 */
export function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  applyEnv(overrides);
  resetRbacStrictModeForTests();
  return run().finally(() => {
    applyEnv(previous);
    resetRbacStrictModeForTests();
  });
}

/** CIF con letra de control válida derivado de una semilla (mismo algoritmo que structure-e2e.test.mts:87-101). */
export function cifFor(letter: string, seed: number): string {
  const digits = String(Math.abs(seed) % 10_000_000).padStart(7, "0");
  let even = 0;
  let odd = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = Number(digits[i]);
    if (i % 2 === 1) even += d;
    else {
      const doubled = d * 2;
      odd += doubled >= 10 ? doubled - 9 : doubled;
    }
  }
  const control = (10 - ((even + odd) % 10)) % 10;
  return `${letter}${digits}${control}`;
}

function seedFromRun(run: string): number {
  let hash = 0;
  for (const char of run) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** Identificador de ejecución (base36 del reloj + 4 aleatorios), único entre suites paralelas. */
export function newRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// createIsolatedTenant
// ---------------------------------------------------------------------------

type UserSpec = { key: TenantUserKey; local: string; fullName: string; templateKey: string };

const USER_SPECS: readonly UserSpec[] = [
  { key: "owner", local: "owner", fullName: "Propiedad L2", templateKey: "owner" },
  { key: "generalManager", local: "general_manager", fullName: "Dirección general L2", templateKey: "general_manager" },
  { key: "receptionist", local: "receptionist", fullName: "Recepción L2", templateKey: "receptionist" },
  { key: "accountant", local: "accountant", fullName: "Contabilidad L2", templateKey: "accountant" },
  { key: "systems", local: "systems", fullName: "Sistemas L2", templateKey: "admin" }
];

async function seedHotel(input: { organizationId: string; legalEntityId: string; id: string; name: string; code: string }) {
  await prisma.property.create({
    data: {
      id: input.id,
      organizationId: input.organizationId,
      name: input.name,
      code: input.code,
      timezone: "Europe/Madrid",
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      legalEntityId: input.legalEntityId,
      kind: "hotel"
    }
  });
  const roomType = await prisma.roomType.create({
    data: { propertyId: input.id, name: "Doble", code: "DBL", maxOccupancy: 2, baseCapacity: 2, active: true },
    select: { id: true }
  });
  const rooms: string[] = [];
  // Tanda L5: vocabulario cerrado (housekeeping dirty | clean | inspected, mantenimiento
  // ok | blocked | needs_attention, NOT NULL): las tres nacen libres, limpias y sin bloqueo.
  for (const number of ["101", "102", "103"]) {
    const room = await prisma.room.create({
      data: { propertyId: input.id, roomTypeId: roomType.id, number, sellable: true, status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok" },
      select: { id: true }
    });
    rooms.push(room.id);
  }
  const plan = await prisma.ratePlan.create({
    data: { propertyId: input.id, code: "BAR", name: "Tarifa base", ratePlanType: "public", active: true },
    select: { id: true }
  });
  for (const day of RATE_DAYS) {
    await prisma.rateDay.create({
      data: { propertyId: input.id, ratePlanId: plan.id, roomTypeId: roomType.id, date: new Date(`${day}T00:00:00.000Z`), price: "100.00", currency: "EUR" }
    });
  }
  return { roomTypeId: roomType.id, ratePlanId: plan.id, rooms };
}

/**
 * Crea la organización aislada `org_l2_<run>` completa (ver cabecera). Idempotente
 * por run: un segundo `createIsolatedTenant(run)` con el mismo run falla en el
 * `organization.create` (id duplicado) — usa `newRunId()` por suite.
 */
export async function createIsolatedTenant(run: string): Promise<IsolatedTenant> {
  const organizationId = `org_l2_${run}`;
  const legalEntityId = `le_l2_${run}`;
  const propertyA = `prop_l2_a_${run}`;
  const propertyB = `prop_l2_b_${run}`;
  const taxId = cifFor("B", seedFromRun(run));

  await syncPermissionCatalog();
  await prisma.organization.create({ data: { id: organizationId, name: `[L2 test] ${run}`, country: "ES" } });
  await prisma.legalEntity.create({
    data: {
      id: legalEntityId,
      organizationId,
      code: "L2",
      legalName: `L2 Test ${run} SL`,
      taxId,
      fiscalAddress: "Calle Real 1",
      fiscalPostalCode: "15001",
      isDefault: true
    }
  });
  const hotelA = await seedHotel({ organizationId, legalEntityId, id: propertyA, name: `Hotel L2 Norte ${run}`, code: "L2A" });
  const hotelB = await seedHotel({ organizationId, legalEntityId, id: propertyB, name: `Hotel L2 Sur ${run}`, code: "L2B" });
  await provisionOrganizationChart(organizationId);

  const roles: Record<string, string> = {};
  for (const role of await provisionDefaultTemplateRoles(organizationId)) roles[role.templateKey] = role.id;
  // «Administración de sistema» (plantilla admin) no está entre las 22 de
  // organización: se crea como lo hace seed-rbac-demo.ts:710-727.
  const adminRole = await prisma.role.create({
    data: { organizationId, name: ROLE_TEMPLATE_LABELS_ES.admin, templateKey: "admin", ...templateRoleMetadata("admin") },
    select: { id: true }
  });
  await applyRoleTemplate(adminRole.id, "admin");
  roles.admin = adminRole.id;

  const users = {} as Record<TenantUserKey, TenantUser>;
  for (const spec of USER_SPECS) {
    const id = `usr_l2_${spec.local}_${run}`;
    const email = `${spec.local}.l2.${run}@faranda.test`;
    await prisma.user.create({
      data: {
        id,
        organizationId,
        email,
        fullName: spec.fullName,
        status: "active",
        passwordHash: hashPassword(PASSWORD),
        mustChangePassword: false,
        passwordChangedAt: new Date()
      }
    });
    users[spec.key] = { id, email, fullName: spec.fullName, templateKey: spec.templateKey };
  }

  const assign = async (key: TenantUserKey, scope: { scopeType: "property" | "organization"; propertyId?: string }) => {
    const roleId = roles[users[key].templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${users[key].templateKey}» en ${organizationId}.`);
    await prisma.userRoleAssignment.create({
      data: {
        userId: users[key].id,
        roleId,
        scopeType: scope.scopeType,
        propertyId: scope.propertyId ?? null,
        organizationId,
        reason: `seed l2 tenant ${run}`
      }
    });
  };
  await assign("owner", { scopeType: "organization" });
  await assign("generalManager", { scopeType: "property", propertyId: propertyA });
  await assign("generalManager", { scopeType: "property", propertyId: propertyB });
  await assign("receptionist", { scopeType: "property", propertyId: propertyA });
  await assign("accountant", { scopeType: "organization" });
  await assign("systems", { scopeType: "organization" });
  resetRbacScopeCacheForTests();
  // El motor de módulos avanzados resuelve la propiedad en el espejo
  // demoStore.properties (advanced-modules.service.ts requirePropertyAccess),
  // hidratado solo al ARRANCAR el servidor (server.ts:8618): un hotel creado
  // después responde 404 «Propiedad no encontrada.» hasta rehidratar.
  await hydrateTenantMirrors();

  return {
    run,
    organizationId,
    legalEntityId,
    taxId,
    propertyA,
    propertyB,
    roomTypeA: hotelA.roomTypeId,
    roomTypeB: hotelB.roomTypeId,
    ratePlanA: hotelA.ratePlanId,
    ratePlanB: hotelB.ratePlanId,
    roomsA: hotelA.rooms,
    roomsB: hotelB.rooms,
    password: PASSWORD,
    users,
    roles
  };
}

// ---------------------------------------------------------------------------
// enableModules
// ---------------------------------------------------------------------------

/**
 * Activa `codes` en la propiedad (fila property_modules `enabled`, moduleId por
 * código de `modules`) y rehidrata los espejos (hydrateTenantMirrors →
 * demoStore.properties + hydrateAllPropertyModules → demoStore.propertyModules)
 * que leen requirePropertyAccess y el gating síncrono del motor
 * (product-modules.service.ts:257/277).
 */
export async function enableModules(propertyId: string, codes: readonly HotelModuleCode[]): Promise<void> {
  // Garantiza las filas de `modules` (ensureModuleStatePersisted, dentro de hydrateAllPropertyModules).
  await hydrateTenantMirrors();
  const modules = await prisma.module.findMany({ where: { code: { in: [...codes] } }, select: { id: true, code: true } });
  const missing = codes.filter((code) => !modules.some((module) => module.code === code));
  if (missing.length > 0) throw new Error(`Módulos sin fila en modules: ${missing.join(", ")}.`);
  const now = new Date();
  for (const module of modules) {
    await prisma.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId, moduleId: module.id } },
      create: { propertyId, moduleId: module.id, status: "enabled", enabledAt: now },
      update: { status: "enabled", enabledAt: now, disabledAt: null }
    });
  }
  await hydrateTenantMirrors();
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

let loginSeq = 0;

/** POST /auth/login real; null (con el motivo en stderr) cuando el login no devuelve 200. */
export async function login(app: ApiApp, email: string, password: string, deviceId = "l2-integration"): Promise<Session | null> {
  loginSeq += 1;
  const remoteAddress = `127.0.${1 + Math.floor(loginSeq / 200)}.${(loginSeq % 200) + 10}`;
  const res = await app.inject({ method: "POST", url: "/auth/login", remoteAddress, payload: { email, password, deviceId } });
  if (res.statusCode !== 200) {
    console.error(`[l2-tenant] login ${email} → ${res.statusCode}: ${res.body.slice(0, 300)}`);
    return null;
  }
  const body = JSON.parse(res.body) as { token: string; user?: { id?: string } };
  const headers = { Authorization: `Bearer ${body.token}` };
  const me = await app.inject({ method: "GET", url: "/users/me", headers });
  const profile = me.statusCode === 200 ? (JSON.parse(me.body) as { id?: string; userId?: string }) : {};
  return { token: body.token, headers, userId: profile.id ?? profile.userId ?? body.user?.id ?? "", email };
}

/** login que lanza en lugar de devolver null (para `before`). */
export async function loginOrThrow(app: ApiApp, email: string, password: string, deviceId?: string): Promise<Session> {
  const session = await login(app, email, password, deviceId);
  if (!session) throw new Error(`login failed for ${email}`);
  return session;
}

// ---------------------------------------------------------------------------
// farandaInvariants
// ---------------------------------------------------------------------------

export async function farandaInvariants(): Promise<FarandaInvariants> {
  const propertyIds = (await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } })).map((row) => row.id);
  const [invoices, verifactuSubmissions, journalEntries, ledgerImports, reservations] = await Promise.all([
    prisma.invoice.count({ where: { propertyId: { in: propertyIds } } }),
    prisma.verifactuSubmission.count({ where: { propertyId: { in: propertyIds } } }),
    prisma.journalEntry.count({ where: { organizationId: FARANDA_ORG } }),
    prisma.ledgerImport.count({ where: { organizationId: FARANDA_ORG } }),
    prisma.reservation.count({ where: { propertyId: { in: propertyIds } } })
  ]);
  return { invoices, verifactuSubmissions, journalEntries, ledgerImports, reservations };
}

// ---------------------------------------------------------------------------
// cleanupTenant
// ---------------------------------------------------------------------------

type DmmfField = { name: string; kind: string; type: string; isList: boolean };
type DmmfModel = { name: string; fields: DmmfField[] };
type DeleteManyDelegate = {
  findMany(args: { where: Record<string, unknown>; select: { id: true } }): Promise<Array<{ id: string }>>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
};

/**
 * Modelos del cliente Prisma (DMMF). `@prisma/client` no se resuelve desde
 * tests/ (no está izado en la raíz): se carga desde el paquete @hotelos/database,
 * que sí lo tiene como dependencia.
 */
function prismaModels(): DmmfModel[] {
  const requireFromDatabase = createRequire(new URL(import.meta.resolve("@hotelos/database")));
  const { Prisma } = requireFromDatabase("@prisma/client") as { Prisma: { dmmf: { datamodel: { models: DmmfModel[] } } } };
  return Prisma.dmmf.datamodel.models;
}

const lowerFirst = (value: string): string => value.charAt(0).toLowerCase() + value.slice(1);
const upperFirst = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function delegateOf(model: DmmfModel): DeleteManyDelegate {
  const delegate = (prisma as unknown as Record<string, DeleteManyDelegate | undefined>)[lowerFirst(model.name)];
  if (!delegate || typeof delegate.deleteMany !== "function") throw new Error(`[l2-tenant] delegado Prisma desconocido: ${model.name}`);
  return delegate;
}

/** Padre de los campos `<x>Id` cuyo nombre no coincide con el modelo (el resto se resuelve por nombre). */
const PARENT_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  IncidentEvidence: { incidentId: "SafetyIncident" },
  IntegrationEvent: { connectionId: "IntegrationConnection" },
  HousekeepingEvent: { taskId: "HousekeepingTask" },
  AuthoritySubmissionBatchRecord: { batchId: "AuthoritySubmissionBatch" },
  BankStatementLine: { statementId: "BankStatement" },
  ReconciliationMatch: { bankLineId: "BankStatementLine" },
  PayrollSlip: { periodId: "PayrollPeriod" },
  PayrollLine: { slipId: "PayrollSlip" },
  PosOrderLine: { productId: "PosProduct" },
  PropertyCategoryOptionTranslation: { categoryOptionId: "PropertyCategoryOption" },
  MarketplaceListing: { appId: "DeveloperApp" },
  DepreciationLine: { runId: "DepreciationRun" },
  RateChangeJournalItem: { journalId: "RateChangeJournal" },
  FolioRoutingRule: { targetFolioId: "Folio" }
};

/** Tablas globales (catálogos, plataforma) que nunca pertenecen a un tenant: fuera del barrido. */
const GLOBAL_MODELS = new Set([
  "Organization",
  "LegalEntity",
  "Property",
  "Module",
  "Permission",
  "SchedulerLease",
  "IntegrationCategory",
  "IntegrationProvider",
  "CategoryDefinition",
  "AiToolRegistry",
  "AiPromptVersion",
  "ComplianceArea",
  "ComplianceRequirement",
  "TouristTaxRate",
  "TouristTaxExemption"
]);

const hasField = (model: DmmfModel, name: string): boolean => model.fields.some((field) => field.name === name && field.kind === "scalar");

/**
 * Borra TODO lo que cuelga de la organización, en este orden:
 *   0. flushAuditQueues() — los eventos de auditoría en cola aterrizan y se barren;
 *   1. hijos sin columna de propietario (líneas de folio, reservas-huésped, slips
 *      de nómina, items…) resueltos por su padre (ids calculados ANTES de borrar);
 *   2. barrido genérico: todo modelo con propertyId (∈ propiedades de la org),
 *      organizationId (= org), userId (∈ usuarios de la org) o roleId (∈ roles de
 *      la org), con hasta 4 pasadas para respetar las FK Restrict;
 *   3. properties → legal_entities (verifactu_installations antes) → organization.
 * Filtra siempre por ids de la organización: nunca toca otra.
 */
export async function cleanupTenant(organizationId: string): Promise<void> {
  if (!organizationId.startsWith("org_l2_")) throw new Error(`[l2-tenant] cleanupTenant solo borra organizaciones org_l2_*: ${organizationId}`);
  await flushAuditQueues();

  const propertyIds = (await prisma.property.findMany({ where: { organizationId }, select: { id: true } })).map((row) => row.id);
  const userIds = (await prisma.user.findMany({ where: { organizationId }, select: { id: true } })).map((row) => row.id);
  const roleIds = (await prisma.role.findMany({ where: { organizationId }, select: { id: true } })).map((row) => row.id);
  const legalEntityIds = (await prisma.legalEntity.findMany({ where: { organizationId }, select: { id: true } })).map((row) => row.id);

  const models = prismaModels();
  const byName = new Map(models.map((model) => [model.name, model]));
  const scopeFilterOf = (model: DmmfModel): Record<string, unknown> | null => {
    if (GLOBAL_MODELS.has(model.name)) return null;
    if (hasField(model, "organizationId")) return { organizationId };
    if (hasField(model, "propertyId")) return { propertyId: { in: propertyIds } };
    if (hasField(model, "userId")) return { userId: { in: userIds } };
    if (hasField(model, "roleId")) return { roleId: { in: roleIds } };
    if (hasField(model, "legalEntityId")) return { legalEntityId: { in: legalEntityIds } };
    return null;
  };

  // 1. Ids de los modelos sin propietario, a través de su(s) padre(s), memoizados.
  const idsMemo = new Map<string, Promise<string[]>>();
  const scopedIds = (model: DmmfModel, trail: string[] = []): Promise<string[]> => {
    const cached = idsMemo.get(model.name);
    if (cached) return cached;
    const pending = (async () => {
      if (trail.includes(model.name)) return [];
      const filter = scopeFilterOf(model);
      if (filter) return (await delegateOf(model).findMany({ where: filter, select: { id: true } })).map((row) => row.id);
      if (GLOBAL_MODELS.has(model.name)) return [];
      const ids = new Set<string>();
      for (const field of model.fields) {
        if (field.kind !== "scalar" || field.name === "id" || !field.name.endsWith("Id")) continue;
        const parentName = PARENT_ALIASES[model.name]?.[field.name] ?? upperFirst(field.name.slice(0, -2));
        const parent = byName.get(parentName);
        const globalParent = GLOBAL_MODELS.has(parentName) && parentName !== "Property" && parentName !== "LegalEntity";
        if (!parent || globalParent) continue;
        const parentIds =
          parentName === "Property" ? propertyIds : parentName === "LegalEntity" ? legalEntityIds : await scopedIds(parent, [...trail, model.name]);
        if (parentIds.length === 0) continue;
        const rows = await delegateOf(model).findMany({ where: { [field.name]: { in: parentIds } }, select: { id: true } });
        for (const row of rows) ids.add(row.id);
      }
      return [...ids];
    })();
    idsMemo.set(model.name, pending);
    return pending;
  };
  const orphanTargets: Array<{ model: DmmfModel; ids: string[] }> = [];
  for (const model of models) {
    if (scopeFilterOf(model) || GLOBAL_MODELS.has(model.name)) continue;
    const ids = await scopedIds(model);
    if (ids.length > 0) orphanTargets.push({ model, ids });
  }

  // 2. Borrado con reintentos (FK Restrict: el hijo cae en una pasada posterior).
  type Target = { name: string; run: () => Promise<unknown> };
  let pending: Target[] = [
    ...orphanTargets.map(({ model, ids }) => ({ name: model.name, run: () => delegateOf(model).deleteMany({ where: { id: { in: ids } } }) })),
    ...models
      .filter((model) => scopeFilterOf(model) !== null)
      .map((model) => ({ name: model.name, run: () => delegateOf(model).deleteMany({ where: scopeFilterOf(model)! }) }))
  ];
  const errors = new Map<string, string>();
  for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
    const failed: Target[] = [];
    for (const target of pending) {
      try {
        await target.run();
        errors.delete(target.name);
      } catch (error) {
        failed.push(target);
        errors.set(target.name, error instanceof Error ? error.message.split("\n").slice(-1)[0] ?? error.message : String(error));
      }
    }
    pending = failed;
  }
  if (pending.length > 0) {
    throw new Error(`[l2-tenant] cleanupTenant(${organizationId}) dejó residuos en: ${pending.map((target) => `${target.name} (${errors.get(target.name)})`).join("; ")}`);
  }

  // 3. Estructura.
  if (legalEntityIds.length) await prisma.verifactuInstallation.deleteMany({ where: { legalEntityId: { in: legalEntityIds } } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.legalEntity.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
  resetRbacScopeCacheForTests();
}

/** Cuántas organizaciones org_l2_* quedan (0 tras cada suite). */
export async function countResidualTenants(): Promise<number> {
  return prisma.organization.count({ where: { id: { startsWith: "org_l2_" } } });
}
