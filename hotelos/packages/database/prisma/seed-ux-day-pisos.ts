// Tanda UX-3 · lote U0 · pisos y mantenimiento del «día de prueba» UXDAY
// (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §7-§8; recon scratchpad/UX-3/recon-delta.md §Seed U0).
//
// Completa el tenant AISLADO org_uxday / prop_uxday que crea seed-ux-day.ts con
// lo que las personas de pisos y mantenimiento necesitan para las seis tareas
// medidas (e2e/measure/p1…p6) y la auditoría táctil (e2e/pisos):
//
//   · 4 usuarios `*@uxday.test` con roles de plantilla y ámbito de propiedad:
//     pisos (housekeeper) · gobernanta (housekeeping_manager) · mantenimiento
//     (maintenance) · encargado (maintenance_manager);
//   · 3 secciones de pisos: Planta 1 (101-120), Planta 2 (201-220), Plantas 3-4
//     (301-315 + 401-405);
//   · habitaciones elegidas EN TIEMPO DE SEED (nunca las que usan las specs
//     t1…t6 y de humo: 101-104, 110, 111, 204-207, 212, 213, 217-220, 305, 306,
//     310-312, 401): primero las libres sin reserva viva y, si no bastan —con el
//     día estándar de seed-ux-day las 10 libres están todas reservadas para las
//     specs t*—, las ocupadas por un alojado que no sale hoy («stayover»: la
//     limpieza diaria y el bloqueo de mantenimiento son legítimos sobre una
//     ocupada; room-state.service OP-01):
//       5 sucias con tarea pendiente (p1 ratón + tablet + reserva) · 1 sucia con
//       tarea en curso asignada a «Pisos UXDAY» · 2 limpias sin inspeccionar;
//   · partes: 2 abiertos sin asignar normales con habitación (p5 ×2) · 1 en curso
//     asignado a «Mantenimiento UXDAY» · 2 abiertos urgentes con habitación y
//     blocksRoom=false (p6 ×2) · 1 emergencia abierta.
//
// Personas FICTICIAS: los cuatro usuarios llevan el nombre del puesto («Pisos
// UXDAY»…), nunca personas reales (contrato tests/seed-ux-day-pisos-contract.test.mjs).
//
// Idempotente: todas las filas propias llevan id `*_uxday_p*`; antes de escribir
// repone las habitaciones que tocó una pasada anterior (las referidas por sus
// tareas y partes) y borra SOLO sus filas. Ningún deleteMany sale de prop_uxday:
// `deleteOwn` lleva SIEMPRE `propertyId: PROPERTY_ID` y las filas sin propertyId
// (eventos de tarea, fotos de parte, habitaciones de sección) se acotan por el
// id propio de su padre (`hkt_uxday_p*`, `wo_uxday_p*`, `hks_uxday_p*`).
//
//   --dry-run solo imprime el plan (lee la BD para elegir habitaciones) y sale 0 sin escribir.
//
// Orden (API parado: la cadena de auditoría vive en memoria del proceso del API):
//   corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
//   corepack pnpm --filter @hotelos/database db:seed:ux-day-pisos
//
// Autónomo: NO importa seed-ux-day.ts (ejecuta main() al cargarse) ni seed.ts /
// seed-operations.ts; duplica las constantes del tenant, que el contrato fija
// iguales a las de seed-ux-day.ts. Guardado por assertDemoTarget (DATA-05).
import { prisma } from "../src/client.js";
import { hashPassword } from "../src/password.js";
import { assertDemoTarget, type PlannedWrite } from "./lib/demo-guard.js";
import { provisionDefaultTemplateRoles } from "../../../apps/api/src/lib/rbac-catalog.js";

// ---------------------------------------------------------------------------
// Identificadores del tenant (iguales a seed-ux-day.ts; fijados por contrato)
// ---------------------------------------------------------------------------

export const ORG_ID = "org_uxday";
export const PROPERTY_ID = "prop_uxday";
export const PROPERTY_NAME = "Hotel UXDAY (prueba)";
export const EMAIL_DOMAIN = "uxday.test";
/** Contraseña común de los usuarios de prueba (solo demo local; nunca real). `SEED_UXDAY_PASSWORD` la sustituye. */
export const DEMO_PASSWORD = process.env.SEED_UXDAY_PASSWORD?.trim() || "uxday-demo";

/** Prefijos de las filas propias (todas `*_uxday_p*`). */
export const OWN = {
  task: "hkt_uxday_p",
  workOrder: "wo_uxday_p",
  section: "hks_uxday_p",
  sectionRoom: "hksr_uxday_p_",
  user: "usr_uxday_p_"
} as const;

export const USERS_P = [
  { id: `${OWN.user}pisos`, local: "pisos", fullName: "Pisos UXDAY", templateKey: "housekeeper" },
  { id: `${OWN.user}gobernanta`, local: "gobernanta", fullName: "Gobernanta UXDAY", templateKey: "housekeeping_manager" },
  { id: `${OWN.user}mantenimiento`, local: "mantenimiento", fullName: "Mantenimiento UXDAY", templateKey: "maintenance" },
  { id: `${OWN.user}encargado`, local: "encargado", fullName: "Encargado UXDAY", templateKey: "maintenance_manager" }
] as const;

export const SECTIONS = [
  { id: `${OWN.section}1`, code: "P1", name: "Planta 1", numbers: range(101, 120) },
  { id: `${OWN.section}2`, code: "P2", name: "Planta 2", numbers: range(201, 220) },
  { id: `${OWN.section}34`, code: "P34", name: "Plantas 3-4", numbers: [...range(301, 315), ...range(401, 405)] }
] as const;
export const SECTION_IDS: string[] = SECTIONS.map((s) => s.id);

/** Habitaciones que usan las specs t1…t6 y de humo de recepción (seed-ux-day.ts, e2e/*.spec.ts): nunca se eligen. */
export const RESERVED_BY_T_SPECS: ReadonlySet<number> = new Set([
  101, 102, 103, 104, 110, 111, 204, 205, 206, 207, 212, 213, 217, 218, 219, 220, 305, 306, 310, 311, 312, 401
]);

/** Cuántas habitaciones necesita el plan, por papel y en este orden. */
export const ROOM_ROLES = [
  { key: "p1", count: 5, label: "sucia con tarea pendiente (p1)" },
  { key: "in_progress", count: 1, label: "sucia con tarea en curso asignada a Pisos UXDAY" },
  { key: "clean", count: 2, label: "limpia sin inspeccionar" },
  { key: "p5", count: 2, label: "parte abierto sin asignar, normal (p5)" },
  { key: "p6", count: 2, label: "parte abierto urgente, sin bloquear (p6)" },
  { key: "in_progress_wo", count: 1, label: "parte en curso asignado a Mantenimiento UXDAY" },
  { key: "emergency", count: 1, label: "parte de emergencia abierto" }
] as const;
type RoomRole = (typeof ROOM_ROLES)[number]["key"];
export const ROOMS_NEEDED = ROOM_ROLES.reduce((sum, r) => sum + r.count, 0);

/** Partes (título con marcador `UXDAY-P…` para las specs; sin nombres). */
export const WORK_ORDERS = [
  { id: `${OWN.workOrder}5a`, role: "p5", index: 0, title: "Grifo del lavabo gotea · UXDAY-P5A", priority: "normal", status: "open" },
  { id: `${OWN.workOrder}5b`, role: "p5", index: 1, title: "Persiana atascada · UXDAY-P5B", priority: "normal", status: "open" },
  { id: `${OWN.workOrder}_ec`, role: "in_progress_wo", index: 0, title: "Aire acondicionado hace ruido · UXDAY-P-EC", priority: "normal", status: "in_progress", assignedTo: "Mantenimiento UXDAY" },
  { id: `${OWN.workOrder}6a`, role: "p6", index: 0, title: "Fuga de agua en el baño · UXDAY-P6A", priority: "urgent", status: "open" },
  { id: `${OWN.workOrder}6b`, role: "p6", index: 1, title: "Enchufe de la mesilla chispea · UXDAY-P6B", priority: "urgent", status: "open" },
  { id: `${OWN.workOrder}_em`, role: "emergency", index: 0, title: "Olor a gas en el pasillo · UXDAY-P-EM", priority: "emergency", status: "open" }
] as const;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/** Hoy (YYYY-MM-DD) en la zona horaria del hotel. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------
// Elección de habitaciones (lectura)
// ---------------------------------------------------------------------------

export type RoomPick = {
  id: string;
  number: string;
  /** `occupied` = alojado que no sale hoy (stayover); `vacant` = libre sin reserva viva. */
  occupancy: "vacant" | "occupied";
  role: RoomRole;
  /** Índice dentro del papel (p1 → 0..4). */
  index: number;
};

type RoomRow = { id: string; number: string; status: string; housekeepingStatus: string; maintenanceStatus: string; sellable: boolean };

/**
 * Candidatas: activas, vendibles, sin bloqueo de mantenimiento, fuera de la lista
 * de las specs t*, y o bien LIBRES sin reserva viva hoy/mañana (prioridad) o bien
 * OCUPADAS por un alojado que no sale hoy. Las que llegan o salen hoy no valen
 * (las tocan el check-in / check-out de recepción). Orden estable por número.
 */
export function chooseRooms(
  rooms: RoomRow[],
  live: Array<{ assignedRoomId: string | null; status: string; arrivalDate: Date; departureDate: Date }>,
  today: string
): RoomPick[] {
  const todayMs = dateOnly(today).getTime();
  const tomorrowMs = todayMs + 86_400_000;
  const byRoom = new Map<string, { held: boolean; stayover: boolean; any: boolean }>();
  for (const r of live) {
    if (!r.assignedRoomId) continue;
    const entry = byRoom.get(r.assignedRoomId) ?? { held: false, stayover: false, any: false };
    const arrival = r.arrivalDate.getTime();
    const departure = r.departureDate.getTime();
    const overlaps = arrival <= tomorrowMs && departure >= todayMs;
    if (overlaps) entry.any = true;
    if (r.status === "confirmed" && arrival <= tomorrowMs && departure >= todayMs) entry.held = true; // llega hoy o mañana sin check-in
    if (r.status === "checked_in" && departure <= todayMs) entry.held = true; // sale hoy
    if (r.status === "checked_in" && departure > todayMs) entry.stayover = true;
    byRoom.set(r.assignedRoomId, entry);
  }
  const byNumber = (a: RoomRow, b: RoomRow) => a.number.localeCompare(b.number, "es", { numeric: true });
  const eligible = rooms
    .filter((room) => !RESERVED_BY_T_SPECS.has(Number(room.number)))
    .filter((room) => room.sellable && room.maintenanceStatus === "ok" && room.status !== "out_of_order" && room.status !== "out_of_service")
    .sort(byNumber);
  const vacant = eligible.filter((room) => !byRoom.get(room.id)?.any && room.status !== "occupied");
  const occupied = eligible.filter((room) => {
    const entry = byRoom.get(room.id);
    return room.status === "occupied" && entry?.stayover && !entry.held;
  });
  const ordered = [...vacant.map((room) => ({ room, occupancy: "vacant" as const })), ...occupied.map((room) => ({ room, occupancy: "occupied" as const }))];
  const picks: RoomPick[] = [];
  let cursor = 0;
  for (const role of ROOM_ROLES) {
    for (let index = 0; index < role.count; index += 1) {
      const next = ordered[cursor];
      cursor += 1;
      if (!next) break;
      picks.push({ id: next.room.id, number: next.room.number, occupancy: next.occupancy, role: role.key, index });
    }
  }
  return picks;
}

async function loadPicks(today: string): Promise<{ picks: RoomPick[]; vacant: number; occupied: number }> {
  const rooms = await prisma.room.findMany({
    where: { propertyId: PROPERTY_ID, active: true },
    select: { id: true, number: true, status: true, housekeepingStatus: true, maintenanceStatus: true, sellable: true }
  });
  const live = await prisma.reservation.findMany({
    where: { propertyId: PROPERTY_ID, status: { in: ["confirmed", "checked_in"] }, assignedRoomId: { not: null } },
    select: { assignedRoomId: true, status: true, arrivalDate: true, departureDate: true }
  });
  const picks = chooseRooms(rooms, live, today);
  return { picks, vacant: picks.filter((p) => p.occupancy === "vacant").length, occupied: picks.filter((p) => p.occupancy === "occupied").length };
}

// ---------------------------------------------------------------------------
// Borrado acotado (todo dentro de prop_uxday)
// ---------------------------------------------------------------------------

type OwnModel = "housekeepingTask" | "workOrder" | "housekeepingSection";

/** Borra filas propias del modelo SOLO dentro de prop_uxday (`propertyId: PROPERTY_ID` siempre). */
async function deleteOwn(model: OwnModel, extraWhere: Record<string, unknown>): Promise<number> {
  const where = { ...extraWhere, propertyId: PROPERTY_ID };
  const delegate = prisma[model] as unknown as { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };
  const result = await delegate.deleteMany({ where });
  return result.count;
}

/**
 * Repone las habitaciones que tocó una pasada anterior (las referidas por las
 * tareas y partes propios): limpia, mantenimiento ok, vendible; una ocupada
 * sigue ocupada. No toca una habitación que bloquee un parte ajeno abierto.
 */
async function restorePreviousRooms(): Promise<number> {
  const [tasks, orders] = await Promise.all([
    prisma.housekeepingTask.findMany({ where: { propertyId: PROPERTY_ID, id: { startsWith: OWN.task } }, select: { roomId: true } }),
    prisma.workOrder.findMany({ where: { propertyId: PROPERTY_ID, id: { startsWith: OWN.workOrder } }, select: { roomId: true } })
  ]);
  const roomIds = new Set<string>();
  for (const t of tasks) roomIds.add(t.roomId);
  for (const o of orders) if (o.roomId) roomIds.add(o.roomId);
  if (roomIds.size === 0) return 0;
  const foreignBlocks = await prisma.workOrder.findMany({
    where: { propertyId: PROPERTY_ID, roomId: { in: [...roomIds] }, blocksRoom: true, status: { notIn: ["resolved", "closed"] }, NOT: { id: { startsWith: OWN.workOrder } } },
    select: { roomId: true }
  });
  const keep = new Set(foreignBlocks.map((b) => b.roomId));
  let restored = 0;
  for (const roomId of roomIds) {
    if (keep.has(roomId)) continue;
    const room = await prisma.room.findFirst({ where: { id: roomId, propertyId: PROPERTY_ID }, select: { status: true } });
    if (!room) continue;
    await prisma.room.update({
      where: { id: roomId },
      data: { housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true, status: room.status === "occupied" ? "occupied" : "clean" }
    });
    restored += 1;
  }
  return restored;
}

async function deletePrevious(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  counts.roomsRestored = await restorePreviousRooms();
  counts.housekeepingEvent = (await prisma.housekeepingEvent.deleteMany({ where: { taskId: { startsWith: OWN.task } } })).count;
  counts.housekeepingTask = await deleteOwn("housekeepingTask", { id: { startsWith: OWN.task } });
  counts.workOrderMedia = (await prisma.workOrderMedia.deleteMany({ where: { workOrderId: { startsWith: OWN.workOrder } } })).count;
  counts.workOrder = await deleteOwn("workOrder", { id: { startsWith: OWN.workOrder } });
  counts.sectionRooms = (await prisma.housekeepingSectionRoom.deleteMany({ where: { housekeepingSectionId: { in: SECTION_IDS } } })).count;
  return counts;
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

async function ensureUsers(): Promise<void> {
  const property = await prisma.property.findFirst({ where: { id: PROPERTY_ID, organizationId: ORG_ID }, select: { id: true } });
  if (!property) throw new Error(`No existe ${PROPERTY_ID} en ${ORG_ID}: ejecuta antes db:seed:ux-day.`);
  const roles: Record<string, string> = {};
  for (const role of await provisionDefaultTemplateRoles(ORG_ID)) roles[role.templateKey] = role.id;
  for (const spec of USERS_P) {
    const email = `${spec.local}@${EMAIL_DOMAIN}`;
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
    if (existing && existing.organizationId !== ORG_ID) {
      throw new Error(`El correo ${email} ya existe en otra organización (${existing.organizationId}); el seed no lo toca.`);
    }
    await prisma.user.upsert({
      where: { email },
      update: { fullName: spec.fullName, status: "active" },
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
        data: { userId, roleId, scopeType: "property", propertyId: PROPERTY_ID, organizationId: ORG_ID, reason: "seed ux-day-pisos (tenant de prueba)" }
      });
    }
  }
}

async function ensureSections(): Promise<number> {
  const rooms = await prisma.room.findMany({ where: { propertyId: PROPERTY_ID }, select: { id: true, number: true } });
  const idByNumber = new Map(rooms.map((r) => [r.number, r.id] as const));
  const rows: Array<{ id: string; housekeepingSectionId: string; roomId: string }> = [];
  for (const section of SECTIONS) {
    await prisma.housekeepingSection.upsert({
      where: { id: section.id },
      update: { name: section.name, code: section.code, active: true },
      create: { id: section.id, propertyId: PROPERTY_ID, name: section.name, code: section.code, description: "Sección de pisos del hotel de prueba UXDAY", active: true }
    });
    for (const number of section.numbers) {
      const roomId = idByNumber.get(String(number));
      if (roomId) rows.push({ id: `${OWN.sectionRoom}${number}`, housekeepingSectionId: section.id, roomId });
    }
  }
  const created = await prisma.housekeepingSectionRoom.createMany({ data: rows, skipDuplicates: true });
  return created.count;
}

async function seedRooms(picks: RoomPick[], today: string): Promise<{ tasks: number; orders: number }> {
  const dueAt = new Date(`${today}T13:00:00.000Z`);
  let tasks = 0;
  for (const pick of picks) {
    const dirtyStatus = pick.occupancy === "occupied" ? "occupied" : "dirty";
    const cleanStatus = pick.occupancy === "occupied" ? "occupied" : "clean";
    const taskType = pick.occupancy === "occupied" ? "stayover" : "departure_clean";
    if (pick.role === "p1") {
      await prisma.room.update({ where: { id: pick.id }, data: { housekeepingStatus: "dirty", status: dirtyStatus } });
      await prisma.housekeepingTask.create({
        data: { id: `${OWN.task}1_${pick.index + 1}`, propertyId: PROPERTY_ID, roomId: pick.id, taskType, priority: "high", status: "pending", dueAt }
      });
      tasks += 1;
    } else if (pick.role === "in_progress") {
      await prisma.room.update({ where: { id: pick.id }, data: { housekeepingStatus: "dirty", status: dirtyStatus } });
      await prisma.housekeepingTask.create({
        data: { id: `${OWN.task}_ec`, propertyId: PROPERTY_ID, roomId: pick.id, taskType, priority: "normal", status: "in_progress", assignedTo: "Pisos UXDAY", dueAt }
      });
      tasks += 1;
    } else if (pick.role === "clean") {
      await prisma.room.update({ where: { id: pick.id }, data: { housekeepingStatus: "clean", status: cleanStatus } });
    }
  }
  let orders = 0;
  for (const spec of WORK_ORDERS) {
    const pick = picks.find((p) => p.role === spec.role && p.index === spec.index);
    if (!pick) throw new Error(`Sin habitación para el parte ${spec.id} (${spec.role}).`);
    await prisma.workOrder.create({
      data: {
        id: spec.id,
        propertyId: PROPERTY_ID,
        roomId: pick.id,
        title: spec.title,
        description: `Hab. ${pick.number} · reportado por pisos (hotel de prueba UXDAY).`,
        priority: spec.priority,
        status: spec.status,
        blocksRoom: false,
        createdBy: "seed-ux-day-pisos",
        assignedTo: "assignedTo" in spec ? spec.assignedTo : null
      }
    });
    orders += 1;
  }
  return { tasks, orders };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  if (process.env.NODE_ENV === "production" && process.env.SEED_UXDAY_ALLOW_PRODUCTION !== "1") {
    throw new Error("[seed-ux-day-pisos] NODE_ENV=production: el tenant de prueba UXDAY (usuarios con contraseña conocida) no se siembra en producción. Exporta SEED_UXDAY_ALLOW_PRODUCTION=1 solo para una demo aislada.");
  }
  const today = todayIn("Europe/Madrid");
  const { picks, vacant, occupied } = await loadPicks(today);
  if (picks.length < ROOMS_NEEDED) {
    throw new Error(`[seed-ux-day-pisos] solo ${picks.length} habitaciones candidatas de ${ROOMS_NEEDED} (fuera de las de las specs t*, libres o con alojado que no sale hoy): rearma el día con db:seed:ux-day -- --reset.`);
  }
  const sectionRooms = SECTIONS.reduce((sum, s) => sum + s.numbers.length, 0);
  const planned: PlannedWrite[] = [
    { table: "rooms (repuestas de una pasada anterior) / housekeeping_events / housekeeping_tasks / work_order_media / work_orders / housekeeping_section_rooms", op: "deleteMany", where: `property_id = ${PROPERTY_ID} AND id LIKE '%_uxday_p%' (o padre propio)` },
    { table: "users + user_role_assignments", op: "upsert", where: `*@${EMAIL_DOMAIN}`, count: USERS_P.length },
    { table: "housekeeping_sections / housekeeping_section_rooms", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: SECTIONS.length + sectionRooms },
    { table: "rooms (limpieza)", op: "update", where: `property_id = ${PROPERTY_ID} AND id IN (${picks.filter((p) => p.role === "p1" || p.role === "in_progress" || p.role === "clean").map((p) => p.number).join(", ")})`, count: 8 },
    { table: "housekeeping_tasks", op: "create", where: `id LIKE '${OWN.task}%'`, count: 6 },
    { table: "work_orders", op: "create", where: `id LIKE '${OWN.workOrder}%'`, count: WORK_ORDERS.length }
  ];

  log(`[seed-ux-day-pisos] hoy (Europe/Madrid) = ${today} · ${picks.length} habitaciones elegidas (${vacant} libres · ${occupied} con alojado que no sale hoy)${dryRun ? " · --dry-run" : ""}`);
  for (const role of ROOM_ROLES) {
    log(`  ${role.key.padEnd(15)} ${picks.filter((p) => p.role === role.key).map((p) => `${p.number}${p.occupancy === "occupied" ? "*" : ""}`).join(", ")} — ${role.label}`);
  }
  log("  (* = ocupada por un alojado que no sale hoy)");
  if (dryRun) {
    for (const p of planned) log(`  ${p.op.padEnd(10)} ${p.table}${typeof p.count === "number" ? ` ×${p.count}` : ""}${p.where ? ` — ${p.where}` : ""}`);
    log("[seed-ux-day-pisos] dry-run: nada escrito.");
    return;
  }

  assertDemoTarget({ orgId: ORG_ID, propertyId: PROPERTY_ID, action: "seed-ux-day-pisos (ensure)", planned });

  const deleted = await deletePrevious();
  await ensureUsers();
  const sectionRoomsCreated = await ensureSections();
  const written = await seedRooms(picks, today);

  log(
    `[seed-ux-day-pisos] listo · ${PROPERTY_NAME} (${PROPERTY_ID}) · borrado previo ${Object.entries(deleted).map(([k, v]) => `${k}=${v}`).join(" · ")} · ` +
      `usuarios ${USERS_P.map((u) => `${u.local}@${EMAIL_DOMAIN}`).join(", ")} (contraseña ${DEMO_PASSWORD}) · ` +
      `secciones ${SECTIONS.length} (${sectionRoomsCreated} habitaciones) · tareas ${written.tasks} · partes ${written.orders}`
  );
}

main()
  .catch((error) => {
    console.error("[seed-ux-day-pisos] ERROR:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
