import { prisma } from "@hotelos/database";

export type HousekeepingDashboardInput = {
  propertyId: string;
  date?: string;
};

export type HousekeepingDashboardKpis = {
  roomsClean: number;
  roomsDirty: number;
  roomsInspected: number;
  roomsOutOfOrder: number;
  tasksOpen: number;
  tasksOverdue: number;
  avgMinutesPerRoom: number;
};

export type HousekeepingDashboardResult = {
  kpis: HousekeepingDashboardKpis;
  roomsByStatus: Array<{ status: string; count: number }>;
  tasksByPriority: Array<{ priority: string; count: number }>;
  topAreas: Array<{ areaName: string; openTasks: number }>;
  assignments: Array<{ staffName: string; assigned: number; completed: number }>;
};

const OPEN_TASK_STATUSES = ["pending", "assigned", "in_progress"] as const;

function startOfDayUtc(input?: string): Date {
  if (input) {
    const trimmed = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return new Date(`${trimmed}T00:00:00.000Z`);
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
    }
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function endOfDayUtc(start: Date): Date {
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function safeNumber(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return value;
}

export async function buildHousekeepingDashboard(
  input: HousekeepingDashboardInput
): Promise<HousekeepingDashboardResult> {
  const propertyId = input.propertyId;
  const dayStart = startOfDayUtc(input.date);
  const dayEnd = endOfDayUtc(dayStart);
  const now = new Date();

  // Rooms grouped by status — drives KPIs (clean / dirty / inspected / OOO) and the bar table.
  const roomStatusGroups = await prisma.room.groupBy({
    by: ["status"],
    where: { propertyId },
    _count: { _all: true }
  });

  const roomsByStatus = roomStatusGroups.map((row) => ({
    status: String(row.status),
    count: safeNumber(row._count?._all)
  }));

  const statusCount = (status: string): number =>
    safeNumber(roomsByStatus.find((row) => row.status === status)?.count ?? 0);

  const roomsClean = statusCount("clean");
  const roomsDirty = statusCount("dirty");
  const roomsInspected = statusCount("inspected");
  const roomsOutOfOrder = statusCount("out_of_order") + statusCount("out_of_service");

  // Open tasks: pending / assigned / in_progress.
  const tasksOpen = await prisma.housekeepingTask.count({
    where: { propertyId, status: { in: [...OPEN_TASK_STATUSES] } }
  });

  // Overdue: open tasks whose dueAt is in the past relative to now.
  const tasksOverdue = await prisma.housekeepingTask.count({
    where: {
      propertyId,
      status: { in: [...OPEN_TASK_STATUSES] },
      dueAt: { not: null, lt: now }
    }
  });

  // Avg minutes per room today: pair the earliest `assigned`/`created` start event
  // with the matching `done` event for tasks completed today, then average the span.
  // HousekeepingEvent has no relation field to HousekeepingTask in the schema, so we
  // scope by propertyId by first collecting this property's task IDs.
  const propertyTaskIds = await prisma.housekeepingTask.findMany({
    where: { propertyId },
    select: { id: true }
  });
  const propertyTaskIdSet = propertyTaskIds.map((row) => row.id);

  const doneEventsToday = propertyTaskIdSet.length === 0
    ? []
    : await prisma.housekeepingEvent.findMany({
        where: {
          eventType: "done",
          createdAt: { gte: dayStart, lt: dayEnd },
          taskId: { in: propertyTaskIdSet }
        },
        select: { taskId: true, createdAt: true }
      });

  let avgMinutesPerRoom = 0;
  if (doneEventsToday.length > 0) {
    const taskIds = doneEventsToday.map((evt) => evt.taskId);
    const startEvents = await prisma.housekeepingEvent.findMany({
      where: { taskId: { in: taskIds }, eventType: { in: ["assigned", "created"] } },
      select: { taskId: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    const firstStartByTask = new Map<string, Date>();
    for (const evt of startEvents) {
      if (!firstStartByTask.has(evt.taskId)) {
        firstStartByTask.set(evt.taskId, evt.createdAt);
      }
    }
    const spans: number[] = [];
    for (const done of doneEventsToday) {
      const start = firstStartByTask.get(done.taskId);
      if (!start) continue;
      const minutes = (done.createdAt.getTime() - start.getTime()) / 60000;
      if (Number.isFinite(minutes) && minutes > 0) spans.push(minutes);
    }
    if (spans.length > 0) {
      avgMinutesPerRoom = Math.round(spans.reduce((sum, n) => sum + n, 0) / spans.length);
    }
  }

  // Tasks grouped by priority (open tasks only).
  const priorityGroups = await prisma.housekeepingTask.groupBy({
    by: ["priority"],
    where: { propertyId, status: { in: [...OPEN_TASK_STATUSES] } },
    _count: { _all: true }
  });
  const tasksByPriority = priorityGroups.map((row) => ({
    priority: String(row.priority ?? "normal"),
    count: safeNumber(row._count?._all)
  }));

  // Top areas with open tasks — join sections, section rooms, and open tasks.
  const sections = await prisma.housekeepingSection.findMany({
    where: { propertyId, active: true },
    select: { id: true, name: true }
  });

  let topAreas: Array<{ areaName: string; openTasks: number }> = [];
  if (sections.length > 0) {
    const sectionIds = sections.map((s) => s.id);
    const sectionRooms = await prisma.housekeepingSectionRoom.findMany({
      where: { housekeepingSectionId: { in: sectionIds } },
      select: { housekeepingSectionId: true, roomId: true }
    });

    const roomIds = Array.from(new Set(sectionRooms.map((sr) => sr.roomId)));
    const openTasksByRoom = roomIds.length === 0
      ? []
      : await prisma.housekeepingTask.groupBy({
          by: ["roomId"],
          where: {
            propertyId,
            status: { in: [...OPEN_TASK_STATUSES] },
            roomId: { in: roomIds }
          },
          _count: { _all: true }
        });

    const openByRoomId = new Map<string, number>();
    for (const row of openTasksByRoom) {
      openByRoomId.set(row.roomId, safeNumber(row._count?._all));
    }

    const totals = new Map<string, { name: string; openTasks: number }>();
    for (const section of sections) {
      totals.set(section.id, { name: section.name, openTasks: 0 });
    }
    for (const link of sectionRooms) {
      const entry = totals.get(link.housekeepingSectionId);
      if (!entry) continue;
      entry.openTasks += openByRoomId.get(link.roomId) ?? 0;
    }

    topAreas = Array.from(totals.values())
      .map((entry) => ({ areaName: entry.name, openTasks: entry.openTasks }))
      .sort((a, b) => b.openTasks - a.openTasks)
      .slice(0, 5);
  }

  // Staff assignments today — tasks assigned to staff today (assigned, in_progress, done).
  const tasksAssignedToday = await prisma.housekeepingTask.findMany({
    where: {
      propertyId,
      assignedTo: { not: null },
      OR: [
        { createdAt: { gte: dayStart, lt: dayEnd } },
        { dueAt: { gte: dayStart, lt: dayEnd } }
      ]
    },
    select: { assignedTo: true, status: true }
  });

  const assignmentTotals = new Map<string, { assigned: number; completed: number }>();
  for (const task of tasksAssignedToday) {
    const userId = task.assignedTo;
    if (!userId) continue;
    const entry = assignmentTotals.get(userId) ?? { assigned: 0, completed: 0 };
    entry.assigned += 1;
    if (task.status === "done") entry.completed += 1;
    assignmentTotals.set(userId, entry);
  }

  let assignments: Array<{ staffName: string; assigned: number; completed: number }> = [];
  if (assignmentTotals.size > 0) {
    const userIds = Array.from(assignmentTotals.keys());
    const staffProfiles = await prisma.staffProfile.findMany({
      where: { propertyId, userId: { in: userIds } },
      select: { userId: true, employeeCode: true }
    });
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, fullName: true }
    });
    const nameByUserId = new Map<string, string>();
    for (const user of users) {
      nameByUserId.set(user.id, user.fullName);
    }
    const codeByUserId = new Map<string, string | null>();
    for (const profile of staffProfiles) {
      codeByUserId.set(profile.userId, profile.employeeCode ?? null);
    }

    assignments = userIds
      .map((userId) => {
        const totals = assignmentTotals.get(userId) ?? { assigned: 0, completed: 0 };
        const fullName = nameByUserId.get(userId);
        const code = codeByUserId.get(userId);
        const staffName = fullName ?? code ?? userId;
        return {
          staffName,
          assigned: safeNumber(totals.assigned),
          completed: safeNumber(totals.completed)
        };
      })
      .sort((a, b) => b.assigned - a.assigned);
  }

  return {
    kpis: {
      roomsClean: safeNumber(roomsClean),
      roomsDirty: safeNumber(roomsDirty),
      roomsInspected: safeNumber(roomsInspected),
      roomsOutOfOrder: safeNumber(roomsOutOfOrder),
      tasksOpen: safeNumber(tasksOpen),
      tasksOverdue: safeNumber(tasksOverdue),
      avgMinutesPerRoom: safeNumber(avgMinutesPerRoom)
    },
    roomsByStatus,
    tasksByPriority,
    topAreas,
    assignments
  };
}
