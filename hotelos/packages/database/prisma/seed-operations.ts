// Operations demo seed — populates the live operations boards (Housekeeping,
// Maintenance, Workforce, Safety) with realistic, reviewable demo data so the
// dashboards are not empty. Idempotent:
//   - users / staff profiles / departments are upserted (stable IDs)
//   - child collections are tagged with the "opseed_" id prefix and replaced on
//     every run, so re-running never duplicates and never touches real records.
// Run: node --env-file=../../.env --import tsx prisma/seed-operations.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PID = process.env.SEED_PROPERTY_ID ?? "prop_123";
const ORG = process.env.SEED_ORG_ID ?? "org_123";

const now = new Date();
function at(daysFromNow: number, hour: number, minute = 0): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}
function dayOnly(daysFromNow: number): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const DEPARTMENTS = [
  { id: "dep_reception", name: "Recepción", code: "REC" },
  { id: "dep_housekeeping", name: "Pisos", code: "HSK" },
  { id: "dep_maintenance", name: "Mantenimiento", code: "MNT" },
  { id: "dep_fnb", name: "Restaurante y bar", code: "FNB" }
];

const STAFF = [
  { key: "ana", name: "Ana Torres", dep: "dep_reception", role: "Recepción", type: "full_time", cost: 14 },
  { key: "luis", name: "Luis Gómez", dep: "dep_reception", role: "Recepción noche", type: "full_time", cost: 15 },
  { key: "maria", name: "María Ruiz", dep: "dep_housekeeping", role: "Camarera de pisos", type: "full_time", cost: 12 },
  { key: "carmen", name: "Carmen Díaz", dep: "dep_housekeeping", role: "Camarera de pisos", type: "part_time", cost: 12 },
  { key: "sara", name: "Sara López", dep: "dep_housekeeping", role: "Gobernanta", type: "full_time", cost: 18 },
  { key: "javier", name: "Javier Soto", dep: "dep_maintenance", role: "Técnico de mantenimiento", type: "full_time", cost: 16 },
  { key: "elena", name: "Elena Navarro", dep: "dep_fnb", role: "Sala / restaurante", type: "full_time", cost: 13 },
  { key: "pablo", name: "Pablo Marín", dep: "dep_fnb", role: "Cocina", type: "full_time", cost: 15 }
];

async function wipeSeeded() {
  // Order matters for FKs: children first. All carry the opseed_ id prefix.
  await prisma.timeClockEntry.deleteMany({ where: { id: { startsWith: "opseed_" } } });
  await prisma.shift.deleteMany({ where: { id: { startsWith: "opseed_" } } });
  await prisma.absenceRequest.deleteMany({ where: { id: { startsWith: "opseed_" } } });
  await prisma.housekeepingTask.deleteMany({ where: { id: { startsWith: "opseed_" } } });
  await prisma.workOrder.deleteMany({ where: { id: { startsWith: "opseed_" } } });
  await prisma.safetyIncident.deleteMany({ where: { id: { startsWith: "opseed_" } } });
}

async function main() {
  const property = await prisma.property.findUnique({ where: { id: PID }, select: { id: true, name: true } });
  if (!property) throw new Error(`Property ${PID} not found`);
  console.log(`[ops] property ${PID} (${property.name})`);

  await wipeSeeded();

  // Departments ----------------------------------------------------------------
  for (const d of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { id: d.id },
      create: { id: d.id, propertyId: PID, name: d.name, code: d.code, active: true },
      update: { name: d.name, code: d.code, active: true }
    });
  }

  // Users + staff profiles -----------------------------------------------------
  const profileIdByKey = new Map<string, string>();
  for (const s of STAFF) {
    const userId = `opu_${s.key}`;
    const profileId = `ops_${s.key}`;
    profileIdByKey.set(s.key, profileId);
    await prisma.user.upsert({
      where: { id: userId },
      create: { id: userId, organizationId: ORG, email: `${s.key}@hotelos.demo`, fullName: s.name, status: "active" },
      update: { fullName: s.name, status: "active" }
    });
    await prisma.staffProfile.upsert({
      where: { id: profileId },
      create: { id: profileId, userId, propertyId: PID, departmentId: s.dep, employeeCode: s.key.toUpperCase(), employmentType: s.type, hourlyCost: s.cost, active: true },
      update: { departmentId: s.dep, employmentType: s.type, hourlyCost: s.cost, active: true }
    });
  }

  // Shifts: today + next 2 days, alternating morning / afternoon ----------------
  const shifts: { id: string; staffProfileId: string; departmentId: string; roleLabel: string; start: Date; end: Date }[] = [];
  STAFF.forEach((s, i) => {
    const morning = i % 2 === 0;
    for (const day of [0, 1, 2]) {
      const startH = morning ? 8 : 15;
      const endH = morning ? 16 : 23;
      shifts.push({
        id: `opseed_shift_${s.key}_${day}`,
        staffProfileId: profileIdByKey.get(s.key)!,
        departmentId: s.dep,
        roleLabel: s.role,
        start: at(day, startH),
        end: at(day, endH)
      });
    }
  });
  for (const sh of shifts) {
    await prisma.shift.create({
      data: {
        id: sh.id, propertyId: PID, staffProfileId: sh.staffProfileId, departmentId: sh.departmentId,
        shiftDate: dayOnly(0), startAt: sh.start, endAt: sh.end, status: "scheduled", roleLabel: sh.roleLabel
      }
    });
  }

  // Pending absences -----------------------------------------------------------
  const absences = [
    { key: "carmen", type: "sick", from: 0, to: 1 },
    { key: "pablo", type: "vacation", from: 6, to: 13 },
    { key: "luis", type: "personal", from: 3, to: 3 }
  ];
  for (const a of absences) {
    await prisma.absenceRequest.create({
      data: {
        id: `opseed_abs_${a.key}`, propertyId: PID, staffProfileId: profileIdByKey.get(a.key)!,
        absenceType: a.type, startDate: dayOnly(a.from), endDate: dayOnly(a.to), status: "pending"
      }
    });
  }

  // Time-clock: worked hours this month for a few staff ------------------------
  const workers = ["ana", "maria", "javier", "elena"];
  for (const key of workers) {
    const pid = profileIdByKey.get(key)!;
    // today + two earlier days this month, in 08:00 → out 14:00 (6h each)
    for (const day of [0, -2, -5]) {
      await prisma.timeClockEntry.create({ data: { id: `opseed_tc_${key}_${Math.abs(day)}_in`, propertyId: PID, staffProfileId: pid, clockType: "in", clockAt: at(day, 8), source: "demo", metadataJson: {} } });
      // leave today's "out" open for the two of them so "activos hoy" feels live
      if (!(day === 0 && (key === "ana" || key === "maria"))) {
        await prisma.timeClockEntry.create({ data: { id: `opseed_tc_${key}_${Math.abs(day)}_out`, propertyId: PID, staffProfileId: pid, clockType: "out", clockAt: at(day, 14), source: "demo", metadataJson: {} } });
      }
    }
  }

  // Safety incidents -----------------------------------------------------------
  const incidents = [
    { k: "1", type: "slip_fall", sev: "medium", st: "open", title: "Suelo mojado en recepción", loc: "Vestíbulo planta 0", days: 0 },
    { k: "2", type: "fire_safety", sev: "high", st: "open", title: "Salida de emergencia obstruida", loc: "Escalera norte", days: -1 },
    { k: "3", type: "slip_fall", sev: "high", st: "resolved", title: "Huésped resbaló en zona de piscina", loc: "Terraza", days: -4 },
    { k: "4", type: "fire_safety", sev: "low", st: "resolved", title: "Falsa alarma detector de humos", loc: "Hab. 312", days: -6 },
    { k: "5", type: "theft", sev: "critical", st: "open", title: "Sustracción denunciada en parking", loc: "Parking -1", days: -2 }
  ];
  for (const i of incidents) {
    await prisma.safetyIncident.create({
      data: {
        id: `opseed_inc_${i.k}`, propertyId: PID, incidentType: i.type, severity: i.sev, status: i.st,
        title: i.title, description: `${i.title} — ${i.loc}.`, occurredAt: at(i.days, 10),
        resolvedAt: i.st === "resolved" ? at(i.days, 16) : null
      }
    });
  }

  // Housekeeping: vary room HK status + create tasks ---------------------------
  const rooms = await prisma.room.findMany({ where: { propertyId: PID, active: true }, select: { id: true, number: true }, orderBy: { number: "asc" } });
  const hkCycle = ["dirty", "clean", "inspected", "occupied", "dirty", "clean", "inspected", "dirty"];
  let hkUpdates = 0;
  for (let i = 0; i < rooms.length; i += 1) {
    const status = hkCycle[i % hkCycle.length];
    await prisma.room.update({ where: { id: rooms[i].id }, data: { housekeepingStatus: status } });
    hkUpdates += 1;
  }
  // Tasks on the first several dirty rooms
  const dirtyRooms = rooms.filter((_, i) => hkCycle[i % hkCycle.length] === "dirty").slice(0, 8);
  const taskDefs = [
    { type: "departure_clean", prio: "high", st: "pending", who: "María Ruiz" },
    { type: "stayover", prio: "normal", st: "assigned", who: "Carmen Díaz" },
    { type: "deep_clean", prio: "normal", st: "in_progress", who: "Sara López" },
    { type: "inspection", prio: "high", st: "pending", who: null },
    { type: "departure_clean", prio: "normal", st: "assigned", who: "María Ruiz" },
    { type: "stayover", prio: "low", st: "pending", who: null },
    { type: "departure_clean", prio: "high", st: "in_progress", who: "Carmen Díaz" },
    { type: "deep_clean", prio: "normal", st: "pending", who: null }
  ];
  for (let i = 0; i < dirtyRooms.length; i += 1) {
    const t = taskDefs[i % taskDefs.length];
    await prisma.housekeepingTask.create({
      data: {
        id: `opseed_hk_${i}`, propertyId: PID, roomId: dirtyRooms[i].id, taskType: t.type,
        priority: t.prio, status: t.st as never, assignedTo: t.who, dueAt: at(0, 15)
      }
    });
  }

  // Work orders ----------------------------------------------------------------
  const roomByNumber = new Map(rooms.map((r) => [r.number, r.id]));
  const someRoom = (n: number) => rooms[n % rooms.length]?.id ?? null;
  const wos = [
    { k: "1", title: "Aire acondicionado no enfría", prio: "urgent", st: "in_progress", blocks: false, room: rooms[2]?.id, who: "Javier Soto" },
    { k: "2", title: "Fuga de agua en baño", prio: "emergency", st: "open", blocks: true, room: rooms[5]?.id, who: null },
    { k: "3", title: "Bombilla fundida en pasillo", prio: "normal", st: "open", blocks: false, room: null, who: null },
    { k: "4", title: "Cerradura electrónica no responde", prio: "urgent", st: "assigned", blocks: true, room: rooms[8]?.id, who: "Javier Soto" },
    { k: "5", title: "Mantenimiento preventivo ascensor", prio: "preventive", st: "open", blocks: false, room: null, who: null },
    { k: "6", title: "Televisor sin señal", prio: "normal", st: "resolved", blocks: false, room: rooms[12]?.id, who: "Javier Soto" }
  ];
  void roomByNumber; void someRoom;
  for (const w of wos) {
    await prisma.workOrder.create({
      data: {
        id: `opseed_wo_${w.k}`, propertyId: PID, roomId: w.room ?? null, title: w.title,
        description: `${w.title}.`, priority: w.prio, status: w.st as never, blocksRoom: w.blocks,
        assignedTo: w.who, dueDate: at(1, 12), resolvedAt: w.st === "resolved" ? at(-1, 18) : null
      }
    });
  }

  console.log(`[ops] ${DEPARTMENTS.length} departamentos · ${STAFF.length} empleados · ${shifts.length} turnos · ${absences.length} ausencias · ${incidents.length} incidentes · ${dirtyRooms.length} tareas de pisos · ${wos.length} órdenes de trabajo · ${hkUpdates} habitaciones actualizadas`);
  console.log("[ops] listo.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
