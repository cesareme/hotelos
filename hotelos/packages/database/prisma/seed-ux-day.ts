// Tanda UX-1 · lote U1 · «día de prueba» de recepción (docs/design/UX-RECEPCION-FEEL.md §8.4, §8.6, §8.7).
//
// Crea y rearma un tenant AISLADO propio para las pruebas con usuarios y la
// medida automatizada del camino óptimo (e2e/measure): organización `org_uxday`,
// sociedad `le_uxday`, hotel `prop_uxday` («Hotel UXDAY (prueba)»), tres usuarios
// `*@uxday.test` con roles de plantilla, 60 habitaciones (DBL/SUP/JS), tarifa BAR
// y el «día de prueba» de §8.4 relativo a HOY (Europe/Madrid):
//
//   · 6 llegadas hoy — UXDAY-T1 (DBL sin habitación, saldo 0), UXDAY-A2 (otra sin
//     habitación, saldo 0), UXDAY-A3 (habitación sucia), UXDAY-A4 (VIP), UXDAY-A5
//     (habitación limpia, saldo > 0 → U0b) y UXDAY-A6 (habitación limpia);
//   · 5 salidas hoy — UXDAY-T3 en la 204 con 120 € pendientes, UXDAY-D2 con saldo
//     y UXDAY-D3/D4/D5 con saldo 0;
//   · 41 alojados — UXDAY-T4 en la 310 con orden de trabajo (avería), UXDAY-T6
//     con apellido «Zeta» (búsqueda por apellido), UXDAY-E1 con empresa
//     «Empresa UXDAY SL» (NIF ficticio con checksum válido) y 38 más;
//   · habitaciones libres y limpias sin ninguna reserva: Dobles 101-104 y
//     217-220 (sugerencia del check-in, walk-in y las salidas/reservas que las
//     specs de humo crean por API) y Superior 311-312 (traslado de UXDAY-T4:
//     «Cambiar habitación» en la ficha y ⌥↓ en el Live Timeline);
//   · folios con cargos y cobros que dejan exactamente esos saldos (solo los
//     pagos `captured` cuentan: folio.service.ts getReservationBalance).
//
// Huéspedes FICTICIOS: nombres genéricos y apellidos griegos («Alfa», «Beta»…),
// nunca personas reales (contrato tests/seed-ux-day-contract.test.mjs).
//
// Idempotente: todo se escribe por id fijo (`*_uxday_*`) con upsert; si existe,
// se reutiliza. Nunca toca nada fuera de org_uxday / prop_uxday y nunca borra
// nada de otro tenant: el único `deleteMany` del fichero (deleteScoped) lleva
// SIEMPRE `propertyId: PROPERTY_ID`.
//
//   --reset   rearma el día: borra SOLO filas de prop_uxday (todas las reservas
//             del hotel de prueba —UXDAY-* del seed y las creadas en las tareas
//             T2/T5— sin factura con verifactu_hash, con sus folios/líneas/pagos
//             por cascada, partes de viajeros, envíos SES, tareas y órdenes de
//             trabajo, facturas sin hash) y repone el estado de las habitaciones;
//             las reservas con factura con hash VeriFactu se CONSERVAN (cadena
//             fiscal) pero se cierran (alojada → salida hecha, confirmada →
//             cancelada) para que no retengan habitación en la pasada siguiente:
//             el API (inventory.engine canAssignRoom) y las specs solo consideran
//             ocupada una habitación con reserva confirmed/checked_in solapada.
//             Imprime el plan antes de escribir. Úsalo antes de cada sesión
//             (§8.7 «restaurar el seed») y antes de `pnpm e2e`.
//   --dry-run solo imprime el plan y sale 0 sin escribir.
//
// Ejecuta el seed SIEMPRE con el API parado (la cadena de auditoría vive en
// memoria del proceso del API):
//   cd packages/database && node --env-file=../../.env --import tsx prisma/seed-ux-day.ts [--reset]
//   corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
//
// Guardado por assertDemoTarget (Tanda 4 · DATA-05): org_uxday / prop_uxday están
// en la allowlist demo (lib/demo-guard.ts). Es autónomo: NO importa de seed.ts ni
// de seed-operations.ts (huella de L5). Los helpers del API (catálogo de permisos,
// plan contable, ajustes e impuestos de la propiedad) se importan por ruta
// relativa como en tests/integration/helpers/l2-tenant.mts.
import { prisma } from "../src/client.js";
import { hashPassword } from "../src/password.js";
import { assertDemoTarget, type PlannedWrite } from "./lib/demo-guard.js";
import { ROLE_TEMPLATE_LABELS_ES } from "../../shared/src/index.js";
import {
  applyRoleTemplate,
  provisionDefaultTemplateRoles,
  syncPermissionCatalog,
  templateRoleMetadata
} from "../../../apps/api/src/lib/rbac-catalog.js";
import { provisionOrganizationChart } from "../../../apps/api/src/modules/accounting/chart-of-accounts.service.js";
import { ensurePropertySettings } from "../../../apps/api/src/lib/tenant-hydration.js";

// ---------------------------------------------------------------------------
// Identificadores fijos del tenant (solo de prueba)
// ---------------------------------------------------------------------------

export const ORG_ID = "org_uxday";
export const LEGAL_ENTITY_ID = "le_uxday";
export const PROPERTY_ID = "prop_uxday";
export const PROPERTY_CODE = "UX";
export const PROPERTY_NAME = "Hotel UXDAY (prueba)";
export const EMAIL_DOMAIN = "uxday.test";
/** Contraseña común de los tres usuarios de prueba (solo demo local; nunca real). `SEED_UXDAY_PASSWORD` la sustituye (corrector R9). */
export const DEMO_PASSWORD = process.env.SEED_UXDAY_PASSWORD?.trim() || "uxday-demo";
export const RESERVATION_PREFIX = "UXDAY-";
export const COMPANY_NAME = "Empresa UXDAY SL";
/** Fecha fija de puesta en marcha del hotel de prueba (antes de cualquier día de prueba). */
export const GO_LIVE_AT = new Date("2026-09-01T00:00:00.000Z");

export const USERS = [
  { id: "usr_uxday_recepcion", local: "recepcion", fullName: "Recepción UXDAY", templateKey: "receptionist" },
  { id: "usr_uxday_direccion", local: "direccion", fullName: "Dirección UXDAY", templateKey: "general_manager" },
  { id: "usr_uxday_sistemas", local: "sistemas", fullName: "Sistemas UXDAY", templateKey: "admin" }
] as const;

export const ROOM_TYPES = [
  { id: "rt_uxday_dbl", code: "DBL", name: "Doble", price: 89, maxOccupancy: 2, numbers: [...range(101, 120), ...range(201, 220)] },
  { id: "rt_uxday_sup", code: "SUP", name: "Superior", price: 119, maxOccupancy: 3, numbers: range(301, 315) },
  { id: "rt_uxday_js", code: "JS", name: "Junior suite", price: 159, maxOccupancy: 3, numbers: range(401, 405) }
] as const;

export const RATE_PLAN_ID = "rp_uxday_bar";
export const CANCELLATION_POLICY_ID = "cp_uxday_flex24";
/** Ventana de tarifas publicadas: hoy−7 … hoy+60. */
export const RATE_DAYS_BEFORE = 7;
export const RATE_DAYS_AFTER = 60;

// Nombres genéricos + apellidos griegos: ninguna combinación corresponde a una persona real.
const FIRST_NAMES = ["Ana", "Luis", "Marta", "Pablo", "Elena", "Jorge", "Lucía", "Diego", "Sara", "Iván", "Nuria", "Raúl", "Clara", "Mario", "Irene", "Óscar", "Paula", "Sergio", "Laura", "Hugo"];
// Solo letras griegas de varias sílabas (las cortas —Mu, Xi, Pi…— coinciden con apellidos reales).
const GREEK_SURNAMES = ["Alfa", "Beta", "Gamma", "Delta", "Épsilon", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Ómicron", "Sigma", "Ípsilon", "Omega", "Digamma", "Koppa", "Sampi"];
/** Reservado para UXDAY-T6 (única reserva con ese apellido: la búsqueda por apellido debe ser unívoca). */
const T6_SURNAME = "Zeta";

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/** CIF con letra de control válida (mismo algoritmo que tests/integration/helpers/l2-tenant.mts cifFor). */
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

/** NIF de la sociedad de prueba (número fijo → siempre el mismo CIF). */
export const LEGAL_ENTITY_TAX_ID = cifFor("B", 2026_0919);
/** NIF ficticio de «Empresa UXDAY SL» (distinto del de la sociedad). */
export const COMPANY_TAX_ID = cifFor("B", 7_001_001);

/** Hoy (YYYY-MM-DD) en la zona horaria del hotel. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function nightsBetween(arrival: string, departure: string): number {
  return Math.round((dateOnly(departure).getTime() - dateOnly(arrival).getTime()) / 86_400_000);
}

function money(value: number): string {
  return value.toFixed(2);
}

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------
// Plan del día de prueba (§8.4) — relativo a `today`
// ---------------------------------------------------------------------------

type RoomTypeCode = (typeof ROOM_TYPES)[number]["code"];

export type DayReservation = {
  key: string;
  code: string;
  status: "confirmed" | "checked_in";
  roomType: RoomTypeCode;
  room: number | null;
  arrivalOffset: number;
  departureOffset: number;
  channel: string;
  /** Cobrado (captured) hasta ahora; el resto queda como saldo pendiente. */
  paid: number;
  /** Cargos extra además del alojamiento (concepto → importe bruto). */
  extras?: Array<{ type: string; description: string; amount: number }>;
  vip?: boolean;
  surname?: string;
  company?: boolean;
  specialRequests?: string;
  /** Deja la habitación sucia (llegada «no lista»). */
  dirtyRoom?: boolean;
  /** Orden de trabajo abierta sobre la habitación (avería). */
  workOrder?: string;
};

function priceOf(type: RoomTypeCode): number {
  return ROOM_TYPES.find((t) => t.code === type)!.price;
}

/**
 * Habitaciones de los 38 alojados «de relleno». Quedan libres y limpias, sin ninguna
 * reserva: Dobles 101-104 (sugerencia del check-in y walk-in: «la primera por número»)
 * y 217-220 (las salidas/reservas que quick-checkout, reservation-workspace y
 * reservations-list crean por API eligen «la última por número»), y Superior 311-312
 * (traslado de UXDAY-T4 desde la 310: measure t4 / ficha a la 311, ⌥↓ del Live
 * Timeline a la fila de abajo). Una pasada completa de `pnpm e2e` consume 7 Dobles.
 */
const FILLER_ROOMS: Array<{ room: number; type: RoomTypeCode }> = [
  ...[...range(105, 109), ...range(112, 120), ...range(201, 203), ...range(208, 211), ...range(214, 216)].map((room) => ({ room, type: "DBL" as const })),
  ...[...range(301, 304), ...range(307, 309), ...range(313, 315)].map((room) => ({ room, type: "SUP" as const })),
  ...range(402, 405).map((room) => ({ room, type: "JS" as const }))
];

export function buildDayPlan(): DayReservation[] {
  const plan: DayReservation[] = [
    // Llegadas de hoy (6)
    { key: "t1", code: "UXDAY-T1", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 0, departureOffset: 2, channel: "direct", paid: 178, specialRequests: "UXDAY-T1 · llega sin habitación asignada" },
    { key: "a2", code: "UXDAY-A2", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 0, departureOffset: 1, channel: "ota", paid: 89, specialRequests: "UXDAY-A2 · segunda llegada sin habitación" },
    { key: "a3", code: "UXDAY-A3", status: "confirmed", roomType: "DBL", room: 110, arrivalOffset: 0, departureOffset: 3, channel: "direct", paid: 267, dirtyRoom: true, specialRequests: "UXDAY-A3 · habitación aún sucia" },
    { key: "a4", code: "UXDAY-A4", status: "confirmed", roomType: "SUP", room: 305, arrivalOffset: 0, departureOffset: 2, channel: "phone", paid: 238, vip: true, specialRequests: "UXDAY-A4 · VIP, detalle de bienvenida" },
    { key: "a5", code: "UXDAY-A5", status: "confirmed", roomType: "DBL", room: 111, arrivalOffset: 0, departureOffset: 2, channel: "ota", paid: 50, specialRequests: "UXDAY-A5 · saldo pendiente al llegar" },
    { key: "a6", code: "UXDAY-A6", status: "confirmed", roomType: "JS", room: 401, arrivalOffset: 0, departureOffset: 1, channel: "direct", paid: 159, specialRequests: "UXDAY-A6 · llegada tardía" },
    // Salidas de hoy (5)
    { key: "t3", code: "UXDAY-T3", status: "checked_in", roomType: "DBL", room: 204, arrivalOffset: -2, departureOffset: 0, channel: "direct", paid: 100, extras: [{ type: "minibar", description: "Minibar", amount: 42 }] },
    { key: "d2", code: "UXDAY-D2", status: "checked_in", roomType: "DBL", room: 205, arrivalOffset: -2, departureOffset: 0, channel: "ota", paid: 133 },
    { key: "d3", code: "UXDAY-D3", status: "checked_in", roomType: "DBL", room: 206, arrivalOffset: -2, departureOffset: 0, channel: "direct", paid: 178 },
    { key: "d4", code: "UXDAY-D4", status: "checked_in", roomType: "DBL", room: 207, arrivalOffset: -1, departureOffset: 0, channel: "walk_in", paid: 89 },
    { key: "d5", code: "UXDAY-D5", status: "checked_in", roomType: "SUP", room: 306, arrivalOffset: -2, departureOffset: 0, channel: "phone", paid: 238 },
    // Alojados (41)
    { key: "t4", code: "UXDAY-T4", status: "checked_in", roomType: "SUP", room: 310, arrivalOffset: -1, departureOffset: 2, channel: "direct", paid: 357, workOrder: "Avería: el aire acondicionado de la 310 no enfría" },
    { key: "t6", code: "UXDAY-T6", status: "checked_in", roomType: "DBL", room: 212, arrivalOffset: -1, departureOffset: 1, channel: "direct", paid: 178, surname: T6_SURNAME },
    { key: "e1", code: "UXDAY-E1", status: "checked_in", roomType: "DBL", room: 213, arrivalOffset: -1, departureOffset: 3, channel: "corporate", paid: 356, company: true }
  ];
  FILLER_ROOMS.forEach(({ room, type }, index) => {
    const arrivalOffset = -1 - (index % 3);
    const departureOffset = 1 + (index % 4);
    const nights = departureOffset - arrivalOffset;
    plan.push({
      key: `h${String(index + 1).padStart(2, "0")}`,
      code: `UXDAY-H${String(index + 1).padStart(2, "0")}`,
      status: "checked_in",
      roomType: type,
      room,
      arrivalOffset,
      departureOffset,
      channel: index % 5 === 0 ? "ota" : "direct",
      paid: nights * priceOf(type)
    });
  });
  return plan;
}

/** Huésped ficticio determinista por índice; «Zeta» solo para UXDAY-T6. */
export function guestNameFor(index: number, override?: string): { firstName: string; surname1: string } {
  return {
    firstName: FIRST_NAMES[index % FIRST_NAMES.length],
    surname1: override ?? GREEK_SURNAMES[(index * 7 + Math.floor(index / FIRST_NAMES.length)) % GREEK_SURNAMES.length]
  };
}

// ---------------------------------------------------------------------------
// Borrado acotado (único deleteMany del fichero)
// ---------------------------------------------------------------------------

type ScopedModel =
  | "reservation"
  | "guestRegisterRecord"
  | "sesHospedajesSubmission"
  | "touristTaxApplication"
  | "paymentIntent"
  | "housekeepingTask"
  | "workOrder"
  | "invoice";

/** Borra filas del modelo SOLO dentro de prop_uxday (`propertyId: PROPERTY_ID` siempre). */
async function deleteScoped(model: ScopedModel, extraWhere: Record<string, unknown> = {}): Promise<number> {
  const where = { ...extraWhere, propertyId: PROPERTY_ID };
  const delegate = prisma[model] as unknown as { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };
  const result = await delegate.deleteMany({ where });
  return result.count;
}

// ---------------------------------------------------------------------------
// Tenant (idempotente)
// ---------------------------------------------------------------------------

async function ensureTenant(today: string): Promise<void> {
  const clash = await prisma.legalEntity.findFirst({ where: { taxId: LEGAL_ENTITY_TAX_ID, NOT: { id: LEGAL_ENTITY_ID } }, select: { id: true, organizationId: true } });
  if (clash) {
    throw new Error(`El NIF ${LEGAL_ENTITY_TAX_ID} ya pertenece a la sociedad ${clash.id} (organización ${clash.organizationId}); no se puede crear ${LEGAL_ENTITY_ID}.`);
  }

  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: "UXDAY (pruebas de recepción)", legalName: "UXDAY Pruebas SL", taxId: LEGAL_ENTITY_TAX_ID, country: "ES" }
  });
  await prisma.legalEntity.upsert({
    where: { id: LEGAL_ENTITY_ID },
    update: {},
    create: {
      id: LEGAL_ENTITY_ID,
      organizationId: ORG_ID,
      code: "UXDAY",
      legalName: "UXDAY Pruebas SL",
      taxId: LEGAL_ENTITY_TAX_ID,
      legalForm: "sl",
      fiscalAddress: "Rúa da Proba 1",
      fiscalPostalCode: "15001",
      fiscalMunicipality: "A Coruña",
      fiscalProvince: "A Coruña",
      isDefault: true
    }
  });
  await prisma.property.upsert({
    where: { id: PROPERTY_ID },
    update: {},
    create: {
      id: PROPERTY_ID,
      organizationId: ORG_ID,
      legalEntityId: LEGAL_ENTITY_ID,
      code: PROPERTY_CODE,
      kind: "hotel",
      name: PROPERTY_NAME,
      legalName: "UXDAY Pruebas SL",
      tradeName: PROPERTY_NAME,
      address: "Rúa da Proba 1",
      municipality: "A Coruña",
      province: "A Coruña",
      postalCode: "15001",
      ineMunicipalityCode: "15030",
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      fiscalTerritory: "common",
      timezone: "Europe/Madrid",
      currency: "EUR",
      status: "open",
      goLiveAt: GO_LIVE_AT,
      sesHospedajesEnabled: false,
      verifactuEnabled: false,
      starRating: 3,
      bedCapacity: 130
    }
  });
  await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: PROPERTY_ID },
    update: { sesHospedajesEnabled: false, verifactuEnabled: false },
    create: {
      propertyId: PROPERTY_ID,
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      sesHospedajesEnabled: false,
      verifactuEnabled: false,
      ticketbaiEnabled: false,
      siiEnabled: false,
      b2bEinvoiceEnabled: false,
      configurationJson: {}
    }
  });
  await prisma.businessDate.upsert({
    where: { propertyId: PROPERTY_ID },
    update: { currentDate: dateOnly(today), closedAt: null, closedBy: null },
    create: { propertyId: PROPERTY_ID, currentDate: dateOnly(today) }
  });

  // Catálogo de permisos + roles de plantilla (22 de organización) + «Administración de sistema».
  await syncPermissionCatalog();
  const roles: Record<string, string> = {};
  for (const role of await provisionDefaultTemplateRoles(ORG_ID)) roles[role.templateKey] = role.id;
  const adminRole =
    (await prisma.role.findFirst({ where: { organizationId: ORG_ID, templateKey: "admin" }, select: { id: true } })) ??
    (await prisma.role.create({
      data: { organizationId: ORG_ID, name: ROLE_TEMPLATE_LABELS_ES.admin, templateKey: "admin", ...templateRoleMetadata("admin") },
      select: { id: true }
    }));
  await applyRoleTemplate(adminRole.id, "admin");
  roles.admin = adminRole.id;

  for (const spec of USERS) {
    const email = `${spec.local}@${EMAIL_DOMAIN}`;
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
    if (existing && existing.organizationId !== ORG_ID) {
      throw new Error(`El correo ${email} ya existe en otra organización (${existing.organizationId}); el seed no lo toca.`);
    }
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        id: spec.id,
        organizationId: ORG_ID,
        email,
        fullName: spec.fullName,
        status: "active",
        passwordHash: hashPassword(DEMO_PASSWORD),
        mustChangePassword: false,
        passwordChangedAt: new Date()
      }
    });
    const roleId = roles[spec.templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${ORG_ID}.`);
    const userId = existing?.id ?? spec.id;
    const assignment = await prisma.userRoleAssignment.findFirst({ where: { userId, roleId, scopeType: "property", propertyId: PROPERTY_ID, revokedAt: null }, select: { id: true } });
    if (!assignment) {
      await prisma.userRoleAssignment.create({
        data: { userId, roleId, scopeType: "property", propertyId: PROPERTY_ID, organizationId: ORG_ID, reason: "seed ux-day (tenant de prueba)" }
      });
    }
  }

  // Plan contable (necesario para facturar) y ajustes/impuestos de la propiedad.
  await provisionOrganizationChart(ORG_ID);
  await ensurePropertySettings(PROPERTY_ID);

  // Política de cancelación por defecto (24 h · primera noche).
  await prisma.cancellationPolicy.upsert({
    where: { id: CANCELLATION_POLICY_ID },
    update: { isDefault: true, active: true },
    create: {
      id: CANCELLATION_POLICY_ID,
      propertyId: PROPERTY_ID,
      code: "FLEX24",
      name: "Flexible 24 h",
      description: "Cancelación gratuita hasta 24 h antes de la llegada; después, la primera noche.",
      freeCancelHours: 24,
      penaltyType: "first_night",
      noShowPenaltyType: "first_night",
      active: true,
      isDefault: true
    }
  });

  // Tipos, habitaciones, plan BAR y tarifas publicadas.
  for (const type of ROOM_TYPES) {
    await prisma.roomType.upsert({
      where: { id: type.id },
      update: {},
      create: { id: type.id, propertyId: PROPERTY_ID, code: type.code, name: type.name, maxOccupancy: type.maxOccupancy, baseCapacity: 2, active: true, sellable: true }
    });
    for (const number of type.numbers) {
      await prisma.room.upsert({
        where: { id: `room_uxday_${number}` },
        update: {},
        create: {
          id: `room_uxday_${number}`,
          propertyId: PROPERTY_ID,
          roomTypeId: type.id,
          number: String(number),
          floor: String(Math.floor(number / 100)),
          status: "clean",
          housekeepingStatus: "clean",
          maintenanceStatus: "ok",
          sellable: true,
          active: true,
          sortOrder: number
        }
      });
    }
  }
  await prisma.ratePlan.upsert({
    where: { id: RATE_PLAN_ID },
    update: {},
    create: { id: RATE_PLAN_ID, propertyId: PROPERTY_ID, code: "BAR", name: "Tarifa base", ratePlanType: "public", cancellationPolicyId: CANCELLATION_POLICY_ID, active: true }
  });
  const rateRows = [];
  for (let offset = -RATE_DAYS_BEFORE; offset <= RATE_DAYS_AFTER; offset += 1) {
    for (const type of ROOM_TYPES) {
      rateRows.push({ propertyId: PROPERTY_ID, ratePlanId: RATE_PLAN_ID, roomTypeId: type.id, date: dateOnly(isoPlus(today, offset)), price: money(type.price), currency: "EUR", source: "seed-ux-day" });
    }
  }
  await prisma.rateDay.createMany({ data: rateRows, skipDuplicates: true });
}

// ---------------------------------------------------------------------------
// Día de prueba
// ---------------------------------------------------------------------------

async function resetDay(): Promise<void> {
  // Reservas UXDAY-* con factura con hash VeriFactu: se conservan (cadena fiscal).
  const protectedInvoices = await prisma.invoice.findMany({ where: { propertyId: PROPERTY_ID, verifactuHash: { not: null } }, select: { reservationId: true, folioId: true } });
  const protectedReservationIds = new Set<string>();
  for (const inv of protectedInvoices) {
    if (inv.reservationId) protectedReservationIds.add(inv.reservationId);
    if (inv.folioId) {
      const folio = await prisma.folio.findUnique({ where: { id: inv.folioId }, select: { reservationId: true } });
      if (folio) protectedReservationIds.add(folio.reservationId);
    }
  }
  // Las conservadas siguen solo como historial fiscal: si aún estaban alojadas o
  // confirmadas (las salidas/reservas corporativas que crean quick-checkout.spec
  // y reservation-workspace.spec emiten factura con número), se cierran para que
  // no retengan habitación en la pasada siguiente. El API (canAssignRoom) y las
  // specs (heldRooms) solo consideran ocupada una habitación con reserva
  // confirmed/checked_in solapada, y las habitaciones vuelven a limpias abajo.
  const protectedIds = [...protectedReservationIds];
  const counts: Record<string, number> = {};
  if (protectedIds.length > 0) {
    const closed = await prisma.reservation.updateMany({ where: { propertyId: PROPERTY_ID, id: { in: protectedIds }, status: "checked_in" }, data: { status: "checked_out" } });
    const cancelled = await prisma.reservation.updateMany({ where: { propertyId: PROPERTY_ID, id: { in: protectedIds }, status: "confirmed" }, data: { status: "cancelled" } });
    await prisma.stay.updateMany({ where: { reservationId: { in: protectedIds }, checkoutAt: null }, data: { checkoutAt: new Date(), status: "checked_out" } });
    counts.protectedClosed = closed.count + cancelled.count;
  }
  counts.guestRegisterRecord = await deleteScoped("guestRegisterRecord");
  counts.sesHospedajesSubmission = await deleteScoped("sesHospedajesSubmission");
  counts.touristTaxApplication = await deleteScoped("touristTaxApplication");
  counts.paymentIntent = await deleteScoped("paymentIntent");
  counts.housekeepingTask = await deleteScoped("housekeepingTask");
  counts.workOrder = await deleteScoped("workOrder");
  counts.invoice = await deleteScoped("invoice", { verifactuHash: null });
  // Todas las reservas del hotel de prueba: las UXDAY-* del seed y las que crean
  // las tareas T2/T5 (códigos RES-* del generador); nunca las que tengan una
  // factura con verifactu_hash. Los huéspedes ficticios de la organización se
  // conservan (no tienen propertyId; los del seed se reutilizan por id fijo).
  counts.reservation = await deleteScoped("reservation", { id: { notIn: [...protectedReservationIds] } });
  // Corrector R7: los huéspedes ficticios que crean las tareas (walk-in, modo
  // rápido, salidas de prueba) no tienen propertyId y se acumulaban (178 por 52
  // del plan). Se borran los de org_uxday que ya no enlaza ninguna reserva (los
  // del seed se reutilizan por id fijo y vuelven a enlazarse en seedDay; los de
  // las reservas conservadas siguen enlazados). Único borrado sin propertyId,
  // acotado a organizationId = org_uxday.
  const orphanGuests = await prisma.guest.deleteMany({ where: { organizationId: ORG_ID, reservationGuests: { none: {} } } });
  counts.orphanGuests = orphanGuests.count;
  const rooms = await prisma.room.updateMany({ where: { propertyId: PROPERTY_ID }, data: { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok" } });
  counts.roomsRestored = rooms.count;
  log(`[seed-ux-day] reset: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" · ")}${protectedReservationIds.size ? ` · conservadas ${protectedReservationIds.size} con factura VeriFactu (cerradas: no retienen habitación)` : ""}`);
}

async function seedDay(today: string, plan: DayReservation[]): Promise<{ created: number; existing: number }> {
  const typeById = new Map(ROOM_TYPES.map((t) => [t.code, t.id] as const));
  let created = 0;
  let existing = 0;
  for (const [index, item] of plan.entries()) {
    const reservationId = `res_uxday_${item.key}`;
    const guestId = `guest_uxday_${item.key}`;
    const folioId = `folio_uxday_${item.key}`;
    const name = guestNameFor(index, item.surname);
    const arrival = isoPlus(today, item.arrivalOffset);
    const departure = isoPlus(today, item.departureOffset);
    const nights = nightsBetween(arrival, departure);
    const price = priceOf(item.roomType);
    const roomTotal = nights * price;
    const extrasTotal = (item.extras ?? []).reduce((sum, e) => sum + e.amount, 0);
    const total = roomTotal + extrasTotal;
    const roomId = item.room !== null ? `room_uxday_${item.room}` : null;

    const already = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true } });
    if (already) {
      existing += 1;
      continue;
    }
    created += 1;

    await prisma.guest.upsert({
      where: { id: guestId },
      update: {},
      create: {
        id: guestId,
        organizationId: ORG_ID,
        firstName: name.firstName,
        surname1: name.surname1,
        nationality: "ES",
        documentType: "DNI",
        documentNumber: `UX${String(index + 1).padStart(6, "0")}`,
        company: item.company ? COMPANY_NAME : null,
        vipCode: item.vip ? "VIP" : null
      }
    });
    await prisma.reservation.create({
      data: {
        id: reservationId,
        propertyId: PROPERTY_ID,
        code: item.code,
        channel: item.channel,
        status: item.status,
        arrivalDate: dateOnly(arrival),
        departureDate: dateOnly(departure),
        adults: 2,
        children: 0,
        roomsCount: 1,
        roomTypeId: typeById.get(item.roomType),
        assignedRoomId: roomId,
        ratePlanId: RATE_PLAN_ID,
        boardType: "RO",
        totalAmount: money(total),
        priceSource: "rate_plan",
        currency: "EUR",
        cancellationPolicyId: CANCELLATION_POLICY_ID,
        cancellationPolicyCode: "FLEX24",
        vipFlag: Boolean(item.vip),
        companyName: item.company ? COMPANY_NAME : null,
        billingInstruction: item.company ? "company_invoice" : "guest_pays_checkout",
        internalNotes: item.company ? `Facturar a ${COMPANY_NAME} · NIF ${COMPANY_TAX_ID}` : null,
        specialRequests: item.specialRequests ?? null,
        bookingSource: item.channel
      }
    });
    await prisma.reservationGuest.create({ data: { id: `rg_uxday_${item.key}`, reservationId, guestId, isPrimary: true } });
    await prisma.folio.create({ data: { id: folioId, reservationId, guestId, status: "open", currency: "EUR", label: "guest", isPrimary: true } });
    await prisma.folioLine.create({
      data: {
        id: `fl_uxday_${item.key}_room`,
        folioId,
        type: "room",
        description: `Alojamiento ${item.roomType} · ${nights} ${nights === 1 ? "noche" : "noches"}`,
        quantity: nights,
        unitPrice: money(price),
        taxCode: "ES_IVA_10",
        taxCategory: "accommodation",
        total: money(roomTotal),
        postedBy: "seed-ux-day"
      }
    });
    for (const [n, extra] of (item.extras ?? []).entries()) {
      await prisma.folioLine.create({
        data: {
          id: `fl_uxday_${item.key}_x${n + 1}`,
          folioId,
          type: extra.type,
          description: extra.description,
          quantity: 1,
          unitPrice: money(extra.amount),
          taxCode: "ES_IVA_10",
          taxCategory: "food_beverage",
          total: money(extra.amount),
          postedBy: "seed-ux-day"
        }
      });
    }
    if (item.paid > 0) {
      await prisma.payment.create({
        data: {
          id: `pay_uxday_${item.key}`,
          propertyId: PROPERTY_ID,
          folioId,
          amount: money(item.paid),
          currency: "EUR",
          method: "card",
          methodCode: "card_terminal",
          status: "captured",
          clientRequestId: `seed-ux-day-${item.key}`
        }
      });
    }
    if (item.status === "checked_in" && roomId) {
      await prisma.stay.create({ data: { id: `stay_uxday_${item.key}`, reservationId, roomId, checkinAt: new Date(`${arrival}T14:00:00.000Z`), status: "in_house" } });
      await prisma.room.update({ where: { id: roomId }, data: { status: "occupied", housekeepingStatus: "clean" } });
    }
    if (item.dirtyRoom && roomId) {
      await prisma.room.update({ where: { id: roomId }, data: { status: "dirty", housekeepingStatus: "dirty" } });
      await prisma.housekeepingTask.upsert({
        where: { id: `hkt_uxday_${item.room}` },
        update: {},
        create: { id: `hkt_uxday_${item.room}`, propertyId: PROPERTY_ID, roomId, taskType: "cleaning", priority: "high", status: "pending", dueAt: new Date(`${today}T13:00:00.000Z`) }
      });
    }
    if (item.workOrder && roomId) {
      await prisma.workOrder.upsert({
        where: { id: `wo_uxday_${item.room}` },
        update: {},
        create: { id: `wo_uxday_${item.room}`, propertyId: PROPERTY_ID, roomId, title: item.workOrder, description: "Reportado por el huésped alojado; pendiente de mantenimiento.", priority: "high", status: "open", blocksRoom: false, createdBy: "seed-ux-day" }
      });
    }
  }
  return { created, existing };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const dryRun = args.includes("--dry-run");
  // Corrector R9: el seed crea un usuario con plantilla admin y contraseña
  // conocida; nunca contra una base de producción (la allowlist de demo-guard
  // permite org_uxday en cualquier BD).
  if (process.env.NODE_ENV === "production" && process.env.SEED_UXDAY_ALLOW_PRODUCTION !== "1") {
    throw new Error("[seed-ux-day] NODE_ENV=production: el tenant de prueba UXDAY (usuario admin con contraseña conocida) no se siembra en producción. Exporta SEED_UXDAY_ALLOW_PRODUCTION=1 solo para una demo aislada.");
  }
  const today = todayIn("Europe/Madrid");
  const plan = buildDayPlan();
  const arrivals = plan.filter((r) => r.arrivalOffset === 0).length;
  const departures = plan.filter((r) => r.departureOffset === 0).length;
  const inHouse = plan.filter((r) => r.status === "checked_in" && r.departureOffset > 0).length;
  const roomsTotal = ROOM_TYPES.reduce((sum, t) => sum + t.numbers.length, 0);

  const planned: PlannedWrite[] = [
    { table: "organizations / legal_entities / properties / business_dates", op: "upsert", where: `id = ${ORG_ID} / ${LEGAL_ENTITY_ID} / ${PROPERTY_ID}`, count: 4 },
    { table: "users + user_role_assignments", op: "upsert", where: `*@${EMAIL_DOMAIN}`, count: USERS.length },
    { table: "room_types / rooms / rate_plans / rate_days", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: ROOM_TYPES.length + roomsTotal + 1 + ROOM_TYPES.length * (RATE_DAYS_BEFORE + RATE_DAYS_AFTER + 1) },
    { table: "reservations (+ guests, folios, folio_lines, payments, stays)", op: "create", where: `property_id = ${PROPERTY_ID} AND code LIKE '${RESERVATION_PREFIX}%'`, count: plan.length }
  ];
  if (reset) {
    planned.unshift(
      { table: "reservations conservadas con factura verifactu_hash (+ stays)", op: "update", where: `property_id = ${PROPERTY_ID} → checked_in → checked_out · confirmed → cancelled (no retienen habitación)` },
      { table: "reservations del hotel de prueba (cascada: folios, líneas, pagos, huéspedes de reserva, estancias)", op: "deleteMany", where: `property_id = ${PROPERTY_ID} AND sin factura con verifactu_hash` },
      { table: "guests huérfanos (sin reserva enlazada)", op: "deleteMany", where: `organization_id = ${ORG_ID} AND sin reservation_guests` },
      { table: "guest_register_records / ses_hospedajes_submissions / tourist_tax_applications / payment_intents / housekeeping_tasks / work_orders / invoices (verifactu_hash IS NULL)", op: "deleteMany", where: `property_id = ${PROPERTY_ID}` },
      { table: "rooms", op: "update", where: `property_id = ${PROPERTY_ID} → clean / ok`, count: roomsTotal }
    );
  }

  log(`[seed-ux-day] hoy (Europe/Madrid) = ${today} · ${arrivals} llegadas · ${departures} salidas · ${inHouse} alojados · ${roomsTotal} habitaciones${reset ? " · --reset" : ""}${dryRun ? " · --dry-run" : ""}`);
  if (dryRun) {
    for (const p of planned) log(`  ${p.op.padEnd(10)} ${p.table}${typeof p.count === "number" ? ` ×${p.count}` : ""}${p.where ? ` — ${p.where}` : ""}`);
    log("[seed-ux-day] dry-run: nada escrito.");
    return;
  }

  assertDemoTarget({ orgId: ORG_ID, propertyId: PROPERTY_ID, action: `seed-ux-day (${reset ? "reset" : "ensure"})`, planned });

  await ensureTenant(today);
  if (reset) await resetDay();
  const result = await seedDay(today, plan);

  log(
    `[seed-ux-day] listo · ${PROPERTY_NAME} (${PROPERTY_ID}) · reservas nuevas=${result.created} existentes=${result.existing} · ` +
      `usuarios ${USERS.map((u) => `${u.local}@${EMAIL_DOMAIN}`).join(", ")} (contraseña ${DEMO_PASSWORD}) · ` +
      `sociedad ${LEGAL_ENTITY_TAX_ID} · empresa ${COMPANY_NAME} ${COMPANY_TAX_ID}`
  );
  if (result.existing > 0 && !reset) {
    log("[seed-ux-day] el día ya existía: usa --reset para rearmarlo (llegadas sin check-in, 204 con 120 € pendientes, etc.).");
  }
}

main()
  .catch((error) => {
    console.error("[seed-ux-day] ERROR:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
