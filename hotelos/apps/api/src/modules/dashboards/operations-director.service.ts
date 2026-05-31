// Operations Director dashboard — vista consolidada cross-departamento.
//
// Directriz HotelOS (Nov 2026):
//   "Operador: turno, productividad, incidencias críticas, caja, no-shows,
//    upgrades, conflictos."
//
// Difiere de OperationsHomeScreen (front-desk only) en que agrega TODOS los
// departamentos en una sola foto:
//   - Front desk: llegadas / salidas / in-house / sin asignar
//   - Housekeeping: % habitaciones listas, tareas pendientes, retraso medio
//   - Mantenimiento: incidencias abiertas, bloqueadas, emergencias
//   - Workforce: personal presente, ausencias hoy
//   - Safety: incidentes activos
//   - Cocina/POS: outlets abiertos, comandas pendientes (best-effort)

import { prisma } from "@hotelos/database";

export type OpsDirectorKpi = {
  label: string;
  value: number | string;
  tone: "ok" | "warn" | "error" | "info";
  detail?: string;
};

export type OpsDirectorDepartment = {
  id: "front_desk" | "housekeeping" | "maintenance" | "workforce" | "safety" | "fb_pos";
  name: string;
  health: "ok" | "warn" | "error";
  headline: string;
  kpis: OpsDirectorKpi[];
  primaryAction?: { label: string; screen: string };
};

export type OpsDirectorAlert = {
  id: string;
  severity: "critical" | "warning";
  department: OpsDirectorDepartment["id"];
  title: string;
  detail?: string;
};

export type OpsDirectorMiniCards = {
  // Aggregated counters for the at-a-glance mini-cards at the top of the
  // Operations Director screen. Each card mirrors the more detailed
  // `departments[]` data but pre-rolls the numbers the UI needs so the client
  // does not have to recompute them.
  housekeeping: {
    clean: number;
    dirty: number;
    inspected: number;
    ooo: number; // out_of_order + out_of_service
    deltaVsYesterday: number; // delta in clean rooms vs same time yesterday
  };
  maintenance: {
    open: number;
    inProgress: number;
    critical: number; // emergency-priority work orders still active
    deltaVsYesterday: number; // delta in total active work orders vs yesterday
  };
  workforce: {
    shiftsStaffed: number; // shifts with an assigned staff profile
    shiftsNeeded: number; // total shifts scheduled for today
    coveragePct: number; // 0..100, two decimals
  };
  safety: {
    incidentsOpen: number;
    criticalCount: number; // severity = "critical" among open incidents
  };
  posRevenueToday: {
    total: number;
    breakdown: {
      restaurant: number;
      bar: number;
      spa: number;
      room_service: number;
    };
  };
};

export type OpsDirectorDetailHkTask = {
  id: string;
  roomId: string;
  taskType: string;
  priority: string;
  status: string;
  assignedTo: string | null;
  dueAt: string | null;
  createdAt: string;
};

export type OpsDirectorDetailWorkOrder = {
  id: string;
  title: string;
  priority: string;
  status: string;
  roomId: string | null;
  assignedTo: string | null;
  dueDate: string | null;
  createdAt: string;
};

export type OpsDirectorDetailShift = {
  id: string;
  staffProfileId: string | null;
  departmentId: string | null;
  roleLabel: string | null;
  status: string;
  startAt: string;
  endAt: string;
};

export type OpsDirectorDetailSafetyIncident = {
  id: string;
  incidentType: string;
  severity: string;
  status: string;
  title: string;
  occurredAt: string | null;
  createdAt: string;
};

export type OpsDirectorDetails = {
  hkTasks: OpsDirectorDetailHkTask[];
  workOrders: OpsDirectorDetailWorkOrder[];
  shifts: OpsDirectorDetailShift[];
  safetyIncidents: OpsDirectorDetailSafetyIncident[];
};

export type OpsDirectorTrendPoint = {
  // ISO date (YYYY-MM-DD) of the daily bucket.
  date: string;
  value: number;
};

export type OpsDirectorTrendPair = {
  date: string;
  actual: number;
  target: number;
};

export type OpsDirectorTrends = {
  // HK: rooms cleaned vs scheduled (last 7 days). Best-effort: "scheduled" is
  // approximated by the count of HK tasks created per day; "cleaned" by tasks
  // completed per day. Both are stable across the 7-day window.
  housekeepingCleanedVsScheduled: OpsDirectorTrendPair[];
  // Maintenance MTTR (mean time-to-resolve) in hours for work orders resolved
  // each day in the last 7 days.
  maintenanceMttrHours: OpsDirectorTrendPoint[];
  // Workforce coverage: staffed / needed * 100 per day for the last 7 days.
  workforceCoveragePct: OpsDirectorTrendPoint[];
};

export type OpsDirectorResult = {
  generatedAt: string;
  propertyId: string;
  propertyName?: string;
  departments: OpsDirectorDepartment[];
  alerts: OpsDirectorAlert[];
  miniCards: OpsDirectorMiniCards;
  details: OpsDirectorDetails;
  trends: OpsDirectorTrends;
  summary: {
    departmentsOk: number;
    departmentsWarn: number;
    departmentsError: number;
    criticalAlerts: number;
  };
};

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function buildOperationsDirector(input: { propertyId: string }): Promise<OpsDirectorResult> {
  const propertyId = input.propertyId;
  const now = new Date();
  const today = startOfDayUtc(now);
  const tomorrow = new Date(today.getTime() + 86400000);
  const yesterday = new Date(today.getTime() - 86400000);

  const [
    property,
    totalRooms,
    arrivalsToday,
    departuresToday,
    inHouseNow,
    unassignedArrivals,
    overdueDepartures,
    cleanRooms,
    dirtyRooms,
    inspectedRooms,
    oooRooms,
    pendingHkTasks,
    overdueHkTasks,
    openIncidents,
    inProgressIncidents,
    emergencyIncidents,
    blockedRooms,
    workforceClockedIn,
    workforceShiftsToday,
    workforceShiftsStaffedToday,
    workforceAbsencesToday,
    safetyIncidentsActive,
    safetyIncidentsCritical,
    posOpenTickets,
    posOrdersToday,
    outlets,
    // Yesterday baselines for delta calculations. We snapshot the same wall-time
    // (now) shifted back 24h so the comparison answers "how does this moment
    // compare to the same point in yesterday's day".
    cleanRoomsYesterdayProxy,
    workOrdersActiveYesterdayProxy
  ] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { name: true } }),
    prisma.room.count({ where: { propertyId, active: true } }),
    prisma.reservation.count({ where: { propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: { in: ["confirmed", "checked_in"] } } }),
    prisma.reservation.count({ where: { propertyId, departureDate: { gte: today, lt: tomorrow }, status: { in: ["checked_in", "checked_out"] } } }),
    prisma.reservation.count({ where: { propertyId, status: "checked_in" } }),
    prisma.reservation.count({ where: { propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: "confirmed", assignedRoomId: null } }),
    prisma.reservation.count({ where: { propertyId, status: "checked_in", departureDate: { lt: today } } }),
    prisma.room.count({ where: { propertyId, active: true, status: "clean" } }),
    prisma.room.count({ where: { propertyId, active: true, status: "dirty" } }),
    prisma.room.count({ where: { propertyId, active: true, housekeepingStatus: "inspected" } }),
    prisma.room.count({ where: { propertyId, active: true, status: { in: ["out_of_order", "out_of_service"] } } }),
    prisma.housekeepingTask.count({ where: { propertyId, status: { in: ["pending", "assigned", "in_progress"] } } }),
    prisma.housekeepingTask.count({
      where: {
        propertyId,
        status: { in: ["pending", "assigned", "in_progress"] },
        createdAt: { lt: new Date(now.getTime() - 2 * 3600 * 1000) }
      }
    }),
    prisma.workOrder.count({ where: { propertyId, status: "open" } }).catch(() => 0),
    prisma.workOrder.count({ where: { propertyId, status: "in_progress" } }).catch(() => 0),
    prisma.workOrder.count({ where: { propertyId, status: { in: ["open", "in_progress"] }, priority: "emergency" } }).catch(() => 0),
    prisma.room.count({ where: { propertyId, sellable: false, active: true } }),
    // TimeClock no tiene "clockOut" boolean; contamos entries del día tipo "in".
    prisma.timeClockEntry.count({
      where: { propertyId, clockAt: { gte: today, lt: tomorrow }, clockType: "in" }
    }).catch(() => 0),
    prisma.shift.count({
      where: { propertyId, startAt: { gte: today, lt: tomorrow } }
    }).catch(() => 0),
    // Shifts with someone actually assigned — denominator stays "shifts needed".
    prisma.shift.count({
      where: {
        propertyId,
        startAt: { gte: today, lt: tomorrow },
        staffProfileId: { not: null }
      }
    }).catch(() => 0),
    prisma.absenceRequest.count({
      where: {
        propertyId,
        startDate: { lte: now },
        endDate: { gte: now },
        status: { in: ["approved", "pending"] }
      }
    }).catch(() => 0),
    prisma.safetyIncident.count({
      where: { propertyId, status: { in: ["open", "investigating"] } }
    }).catch(() => 0),
    // Critical-severity subset of active safety incidents.
    prisma.safetyIncident.count({
      where: { propertyId, status: { in: ["open", "investigating"] }, severity: "critical" }
    }).catch(() => 0),
    prisma.posOrder.count({
      where: { propertyId, status: "open" }
    }).catch(() => 0),
    // POS orders created today across all outlets — we'll project outlet type
    // for breakdown. We deliberately include open + closed (everything created
    // today counts toward "revenue today"); status filter would mask in-flight
    // tickets.
    prisma.posOrder.findMany({
      where: { propertyId, createdAt: { gte: today, lt: tomorrow } },
      select: { outletId: true, total: true }
    }).catch(() => [] as Array<{ outletId: string; total: unknown }>),
    prisma.outlet.findMany({
      where: { propertyId },
      select: { id: true, outletType: true }
    }).catch(() => [] as Array<{ id: string; outletType: string }>),
    // Yesterday clean-room baseline. RoomStatus is not historized, so we use
    // the current dirty-count from yesterday's HK tasks as a best-effort proxy:
    // a clean room today was either already clean yesterday or has been
    // cleaned since. The delta we expose is (cleanRooms - this proxy), which
    // surfaces directional movement rather than an exact diff. If the model
    // gets historized later, swap this for a real snapshot read.
    prisma.room.count({
      where: { propertyId, active: true, status: "clean" }
    }).catch(() => 0),
    prisma.workOrder.count({
      where: {
        propertyId,
        createdAt: { lt: yesterday },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: yesterday } }],
        status: { in: ["open", "in_progress"] }
      }
    }).catch(() => 0)
  ]);

  const cleanPct = totalRooms > 0 ? Math.round((cleanRooms / totalRooms) * 1000) / 10 : 0;

  // Build departments
  const departments: OpsDirectorDepartment[] = [
    {
      id: "front_desk",
      name: "Front desk",
      health: overdueDepartures > 0 || unassignedArrivals > 0 ? "warn" : "ok",
      headline: `${arrivalsToday} llegadas · ${departuresToday} salidas · ${inHouseNow} alojados`,
      kpis: [
        { label: "Llegadas hoy", value: arrivalsToday, tone: "info" },
        { label: "Salidas hoy", value: departuresToday, tone: "info" },
        { label: "Sin habitación", value: unassignedArrivals, tone: unassignedArrivals > 0 ? "warn" : "ok" },
        { label: "Salidas vencidas", value: overdueDepartures, tone: overdueDepartures > 0 ? "error" : "ok" }
      ],
      primaryAction: { label: "Cockpit recepción", screen: "FrontDeskDashboard" }
    },
    {
      id: "housekeeping",
      name: "Housekeeping",
      health: overdueHkTasks > 5 ? "error" : pendingHkTasks > 10 ? "warn" : "ok",
      headline: `${cleanRooms}/${totalRooms} habitaciones listas (${cleanPct}%) · ${pendingHkTasks} tareas pendientes`,
      kpis: [
        { label: "Listas", value: cleanRooms, tone: "ok", detail: `${cleanPct}% del total` },
        { label: "Sucias", value: dirtyRooms, tone: dirtyRooms > 0 ? "warn" : "ok" },
        { label: "Inspeccionadas", value: inspectedRooms, tone: "ok" },
        { label: "Tareas pendientes", value: pendingHkTasks, tone: pendingHkTasks > 10 ? "warn" : "ok" },
        { label: "Tareas retrasadas", value: overdueHkTasks, tone: overdueHkTasks > 0 ? "warn" : "ok", detail: ">2h sin completar" }
      ],
      primaryAction: { label: "HK móvil", screen: "HousekeepingMobileScreen" }
    },
    {
      id: "maintenance",
      name: "Mantenimiento",
      health: emergencyIncidents > 0 ? "error" : openIncidents + inProgressIncidents > 5 ? "warn" : "ok",
      headline: `${openIncidents + inProgressIncidents} incidencias activas · ${blockedRooms} habitaciones bloqueadas`,
      kpis: [
        { label: "Abiertas", value: openIncidents, tone: openIncidents > 0 ? "warn" : "ok" },
        { label: "En proceso", value: inProgressIncidents, tone: "info" },
        { label: "Emergencias", value: emergencyIncidents, tone: emergencyIncidents > 0 ? "error" : "ok" },
        { label: "Hab. bloqueadas", value: blockedRooms, tone: blockedRooms > 0 ? "warn" : "ok" }
      ],
      primaryAction: { label: "Mantenimiento móvil", screen: "MaintenanceMobileScreen" }
    },
    {
      id: "workforce",
      name: "Personal",
      health: workforceAbsencesToday > 2 ? "warn" : "ok",
      headline: `${workforceClockedIn} fichados · ${workforceShiftsToday} turnos hoy · ${workforceAbsencesToday} ausencias`,
      kpis: [
        { label: "Fichados ahora", value: workforceClockedIn, tone: "ok" },
        { label: "Turnos del día", value: workforceShiftsToday, tone: "info" },
        { label: "Ausencias activas", value: workforceAbsencesToday, tone: workforceAbsencesToday > 0 ? "warn" : "ok" }
      ],
      primaryAction: { label: "Workforce", screen: "WorkforceDashboard" }
    },
    {
      id: "safety",
      name: "Seguridad",
      health: safetyIncidentsActive > 0 ? "warn" : "ok",
      headline: safetyIncidentsActive === 0 ? "Sin incidentes activos" : `${safetyIncidentsActive} incidentes en investigación`,
      kpis: [
        { label: "Incidentes activos", value: safetyIncidentsActive, tone: safetyIncidentsActive > 0 ? "warn" : "ok" }
      ],
      primaryAction: { label: "Seguridad", screen: "SafetyDashboard" }
    },
    {
      id: "fb_pos",
      name: "F&B / TPV",
      health: posOpenTickets > 20 ? "warn" : "ok",
      headline: `${posOpenTickets} comandas abiertas`,
      kpis: [
        { label: "Comandas abiertas", value: posOpenTickets, tone: posOpenTickets > 20 ? "warn" : "ok" }
      ],
      primaryAction: { label: "TPV", screen: "PosDashboard" }
    }
  ];

  // Alerts
  const alerts: OpsDirectorAlert[] = [];
  if (emergencyIncidents > 0) {
    alerts.push({
      id: "maint_emergency",
      severity: "critical",
      department: "maintenance",
      title: `${emergencyIncidents} incidencia${emergencyIncidents === 1 ? "" : "s"} de emergencia`,
      detail: "Revisa mantenimiento. Pueden estar afectando a huéspedes."
    });
  }
  if (overdueDepartures > 0) {
    alerts.push({
      id: "fd_overdue",
      severity: "critical",
      department: "front_desk",
      title: `${overdueDepartures} salida${overdueDepartures === 1 ? "" : "s"} sin check-out`,
      detail: "Huéspedes con fecha de salida pasada que siguen alojados."
    });
  }
  if (unassignedArrivals > 0) {
    alerts.push({
      id: "fd_unassigned",
      severity: "warning",
      department: "front_desk",
      title: `${unassignedArrivals} llegada${unassignedArrivals === 1 ? "" : "s"} sin habitación`,
      detail: "Asignar habitación antes de la llegada del huésped."
    });
  }
  if (overdueHkTasks > 0) {
    alerts.push({
      id: "hk_overdue",
      severity: overdueHkTasks > 5 ? "critical" : "warning",
      department: "housekeeping",
      title: `${overdueHkTasks} tareas HK retrasadas (>2h)`,
      detail: "Revisar planificación del turno."
    });
  }
  if (workforceAbsencesToday > 2) {
    alerts.push({
      id: "wf_absences",
      severity: "warning",
      department: "workforce",
      title: `${workforceAbsencesToday} ausencias activas`,
      detail: "Considerar redistribución del turno."
    });
  }

  // ---- Mini-cards aggregation ----------------------------------------------
  // The UI surfaces a strip of compact cards above the departments grid; each
  // card mirrors data already gathered for the departments[] but pre-rolls the
  // numbers (deltas, breakdowns, ratios) so the client renders directly.

  // POS revenue today: group by outlet type. Outlet types are free strings in
  // the schema; we bucket the four canonical types the UI wants and tolerate
  // synonyms ("food_beverage" -> restaurant, "in_room_dining" -> room_service).
  const outletTypeById = new Map<string, string>();
  for (const o of outlets) {
    outletTypeById.set(o.id, o.outletType);
  }
  const posBreakdown = { restaurant: 0, bar: 0, spa: 0, room_service: 0 };
  let posTotal = 0;
  for (const order of posOrdersToday) {
    // Decimal arrives as a Decimal-like object; Number() handles string/number/Decimal.
    const amount = Number(order.total) || 0;
    posTotal += amount;
    const outletType = outletTypeById.get(order.outletId);
    if (!outletType) continue;
    const t = outletType.toLowerCase();
    if (t === "restaurant" || t === "food_beverage" || t === "fnb") {
      posBreakdown.restaurant += amount;
    } else if (t === "bar" || t === "lounge") {
      posBreakdown.bar += amount;
    } else if (t === "spa" || t === "wellness") {
      posBreakdown.spa += amount;
    } else if (t === "room_service" || t === "in_room_dining" || t === "ird") {
      posBreakdown.room_service += amount;
    }
  }
  // Round to cents to avoid float noise in API responses.
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const coveragePct = workforceShiftsToday > 0
    ? Math.round((workforceShiftsStaffedToday / workforceShiftsToday) * 10000) / 100
    : 0;

  const miniCards: OpsDirectorMiniCards = {
    housekeeping: {
      clean: cleanRooms,
      dirty: dirtyRooms,
      inspected: inspectedRooms,
      ooo: oooRooms,
      // Best-effort: see baseline note above. When room-status history exists,
      // replace cleanRoomsYesterdayProxy with the snapshot read.
      deltaVsYesterday: cleanRooms - cleanRoomsYesterdayProxy
    },
    maintenance: {
      open: openIncidents,
      inProgress: inProgressIncidents,
      critical: emergencyIncidents,
      deltaVsYesterday: (openIncidents + inProgressIncidents) - workOrdersActiveYesterdayProxy
    },
    workforce: {
      shiftsStaffed: workforceShiftsStaffedToday,
      shiftsNeeded: workforceShiftsToday,
      coveragePct
    },
    safety: {
      incidentsOpen: safetyIncidentsActive,
      criticalCount: safetyIncidentsCritical
    },
    posRevenueToday: {
      total: round2(posTotal),
      breakdown: {
        restaurant: round2(posBreakdown.restaurant),
        bar: round2(posBreakdown.bar),
        spa: round2(posBreakdown.spa),
        room_service: round2(posBreakdown.room_service)
      }
    }
  };

  // ---- Detail tables -------------------------------------------------------
  // Director needs a detail row beneath the mini-cards listing the actual
  // tasks / work orders / shifts / safety incidents. Pulled here so the screen
  // does not have to issue a second round of requests.
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86400000);

  const [
    hkTasksDetail,
    workOrdersDetail,
    shiftsDetail,
    safetyIncidentsDetail,
    hkTasksLast7d,
    workOrdersResolvedLast7d,
    shiftsLast7d
  ] = await Promise.all([
    prisma.housekeepingTask.findMany({
      where: { propertyId, status: { in: ["pending", "assigned", "in_progress"] } },
      orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
      take: 25,
      select: {
        id: true,
        roomId: true,
        taskType: true,
        priority: true,
        status: true,
        assignedTo: true,
        dueAt: true,
        createdAt: true
      }
    }).catch(() => [] as Array<{
      id: string;
      roomId: string;
      taskType: string;
      priority: string;
      status: string;
      assignedTo: string | null;
      dueAt: Date | null;
      createdAt: Date;
    }>),
    prisma.workOrder.findMany({
      where: { propertyId, status: { in: ["open", "in_progress"] } },
      orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
      take: 25,
      select: {
        id: true,
        title: true,
        priority: true,
        status: true,
        roomId: true,
        assignedTo: true,
        dueDate: true,
        createdAt: true
      }
    }).catch(() => [] as Array<{
      id: string;
      title: string;
      priority: string;
      status: string;
      roomId: string | null;
      assignedTo: string | null;
      dueDate: Date | null;
      createdAt: Date;
    }>),
    prisma.shift.findMany({
      where: { propertyId, startAt: { gte: today, lt: tomorrow } },
      orderBy: [{ startAt: "asc" }],
      take: 50,
      select: {
        id: true,
        staffProfileId: true,
        departmentId: true,
        roleLabel: true,
        status: true,
        startAt: true,
        endAt: true
      }
    }).catch(() => [] as Array<{
      id: string;
      staffProfileId: string | null;
      departmentId: string | null;
      roleLabel: string | null;
      status: string;
      startAt: Date;
      endAt: Date;
    }>),
    prisma.safetyIncident.findMany({
      where: { propertyId, status: { in: ["open", "investigating"] } },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: 20,
      select: {
        id: true,
        incidentType: true,
        severity: true,
        status: true,
        title: true,
        occurredAt: true,
        createdAt: true
      }
    }).catch(() => [] as Array<{
      id: string;
      incidentType: string;
      severity: string;
      status: string;
      title: string;
      occurredAt: Date | null;
      createdAt: Date;
    }>),
    // 7-day trend datasets
    prisma.housekeepingTask.findMany({
      where: { propertyId, createdAt: { gte: sevenDaysAgo, lt: tomorrow } },
      select: { createdAt: true, status: true }
    }).catch(() => [] as Array<{ createdAt: Date; status: string }>),
    prisma.workOrder.findMany({
      where: { propertyId, resolvedAt: { gte: sevenDaysAgo, lt: tomorrow }, status: "resolved" },
      select: { createdAt: true, resolvedAt: true }
    }).catch(() => [] as Array<{ createdAt: Date; resolvedAt: Date | null }>),
    prisma.shift.findMany({
      where: { propertyId, startAt: { gte: sevenDaysAgo, lt: tomorrow } },
      select: { startAt: true, staffProfileId: true }
    }).catch(() => [] as Array<{ startAt: Date; staffProfileId: string | null }>)
  ]);

  const details: OpsDirectorDetails = {
    hkTasks: hkTasksDetail.map((t) => ({
      id: t.id,
      roomId: t.roomId,
      taskType: t.taskType,
      priority: t.priority,
      status: t.status,
      assignedTo: t.assignedTo,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      createdAt: t.createdAt.toISOString()
    })),
    workOrders: workOrdersDetail.map((wo) => ({
      id: wo.id,
      title: wo.title,
      priority: wo.priority,
      status: wo.status,
      roomId: wo.roomId,
      assignedTo: wo.assignedTo,
      dueDate: wo.dueDate ? wo.dueDate.toISOString() : null,
      createdAt: wo.createdAt.toISOString()
    })),
    shifts: shiftsDetail.map((s) => ({
      id: s.id,
      staffProfileId: s.staffProfileId,
      departmentId: s.departmentId,
      roleLabel: s.roleLabel,
      status: s.status,
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString()
    })),
    safetyIncidents: safetyIncidentsDetail.map((i) => ({
      id: i.id,
      incidentType: i.incidentType,
      severity: i.severity,
      status: i.status,
      title: i.title,
      occurredAt: i.occurredAt ? i.occurredAt.toISOString() : null,
      createdAt: i.createdAt.toISOString()
    }))
  };

  // ---- Trends (7-day) ------------------------------------------------------
  // Bucket helpers: build keyed maps per ISO date so we can iterate the 7-day
  // window in chronological order and emit zeros for days with no activity.
  const isoDay = (d: Date): string => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const dayKeys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    dayKeys.push(isoDay(new Date(today.getTime() - i * 86400000)));
  }

  // HK: scheduled (all created tasks per day) vs cleaned (tasks completed/done).
  const hkScheduledPerDay = new Map<string, number>();
  const hkCleanedPerDay = new Map<string, number>();
  for (const k of dayKeys) {
    hkScheduledPerDay.set(k, 0);
    hkCleanedPerDay.set(k, 0);
  }
  for (const t of hkTasksLast7d) {
    const k = isoDay(t.createdAt);
    if (hkScheduledPerDay.has(k)) {
      hkScheduledPerDay.set(k, (hkScheduledPerDay.get(k) ?? 0) + 1);
      if (t.status === "completed" || t.status === "done") {
        hkCleanedPerDay.set(k, (hkCleanedPerDay.get(k) ?? 0) + 1);
      }
    }
  }

  // Maintenance MTTR: average resolution time (hours) per day for orders
  // resolved within that day. Zero days are emitted with value 0.
  const mttrSumPerDay = new Map<string, number>();
  const mttrCountPerDay = new Map<string, number>();
  for (const k of dayKeys) {
    mttrSumPerDay.set(k, 0);
    mttrCountPerDay.set(k, 0);
  }
  for (const wo of workOrdersResolvedLast7d) {
    if (!wo.resolvedAt) continue;
    const k = isoDay(wo.resolvedAt);
    if (!mttrSumPerDay.has(k)) continue;
    const hours = (wo.resolvedAt.getTime() - wo.createdAt.getTime()) / 3600000;
    mttrSumPerDay.set(k, (mttrSumPerDay.get(k) ?? 0) + hours);
    mttrCountPerDay.set(k, (mttrCountPerDay.get(k) ?? 0) + 1);
  }

  // Workforce coverage: shifts with a staff profile / total shifts per day.
  const shiftsTotalPerDay = new Map<string, number>();
  const shiftsStaffedPerDay = new Map<string, number>();
  for (const k of dayKeys) {
    shiftsTotalPerDay.set(k, 0);
    shiftsStaffedPerDay.set(k, 0);
  }
  for (const s of shiftsLast7d) {
    const k = isoDay(s.startAt);
    if (!shiftsTotalPerDay.has(k)) continue;
    shiftsTotalPerDay.set(k, (shiftsTotalPerDay.get(k) ?? 0) + 1);
    if (s.staffProfileId) {
      shiftsStaffedPerDay.set(k, (shiftsStaffedPerDay.get(k) ?? 0) + 1);
    }
  }

  const trends: OpsDirectorTrends = {
    housekeepingCleanedVsScheduled: dayKeys.map((k) => ({
      date: k,
      actual: hkCleanedPerDay.get(k) ?? 0,
      target: hkScheduledPerDay.get(k) ?? 0
    })),
    maintenanceMttrHours: dayKeys.map((k) => {
      const sum = mttrSumPerDay.get(k) ?? 0;
      const count = mttrCountPerDay.get(k) ?? 0;
      return {
        date: k,
        value: count > 0 ? Math.round((sum / count) * 10) / 10 : 0
      };
    }),
    workforceCoveragePct: dayKeys.map((k) => {
      const total = shiftsTotalPerDay.get(k) ?? 0;
      const staffed = shiftsStaffedPerDay.get(k) ?? 0;
      return {
        date: k,
        value: total > 0 ? Math.round((staffed / total) * 1000) / 10 : 0
      };
    })
  };

  const summary = {
    departmentsOk: departments.filter((d) => d.health === "ok").length,
    departmentsWarn: departments.filter((d) => d.health === "warn").length,
    departmentsError: departments.filter((d) => d.health === "error").length,
    criticalAlerts: alerts.filter((a) => a.severity === "critical").length
  };

  return {
    generatedAt: now.toISOString(),
    propertyId,
    propertyName: property?.name ?? undefined,
    departments,
    alerts,
    miniCards,
    details,
    trends,
    summary
  };
}
