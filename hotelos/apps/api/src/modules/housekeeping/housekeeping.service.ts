import { prisma } from "@hotelos/database";
import {
  demoStore,
  type HousekeepingEventRecord,
  type HousekeepingTaskRecord,
  type RoomRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { NotFoundError } from "../../lib/http-error.js";

// Housekeeping writes now PERSIST TO PRISMA (housekeeping_tasks / housekeeping_events
// / rooms) so the Prisma-backed housekeeping dashboard reflects them. Previously
// these wrote only to the in-memory demo store, which the dashboard never read —
// a created task or a "mark clean" silently never showed up. We keep a best-effort
// mirror into the demo store so the legacy demo board (getHousekeepingBoard) and
// other demo readers stay consistent for the seeded demo property.

export type HousekeepingBoardItem = {
  room: RoomRecord;
  tasks: HousekeepingTaskRecord[];
};

type PrismaHkTask = {
  id: string;
  propertyId: string;
  roomId: string;
  taskType: string;
  priority: string;
  status: string;
  assignedTo: string | null;
  dueAt: Date | null;
  createdAt: Date;
};

function mapTask(row: PrismaHkTask): HousekeepingTaskRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId,
    taskType: row.taskType as HousekeepingTaskRecord["taskType"],
    priority: row.priority as HousekeepingTaskRecord["priority"],
    status: row.status as HousekeepingTaskRecord["status"],
    assignedTo: row.assignedTo ?? undefined,
    dueAt: row.dueAt ? row.dueAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString()
  };
}

function mirrorTask(task: HousekeepingTaskRecord): void {
  const idx = demoStore.housekeepingTasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) demoStore.housekeepingTasks[idx] = task;
  else demoStore.housekeepingTasks.push(task);
}

function mirrorRoomStatus(
  roomId: string,
  patch: Partial<Pick<RoomRecord, "status" | "housekeepingStatus" | "maintenanceStatus" | "sellable">>
): void {
  const room = demoStore.rooms.find((r) => r.id === roomId);
  if (room) Object.assign(room, patch);
}

function mapRoom(row: {
  id: string;
  propertyId: string;
  roomTypeId: string;
  number: string;
  floor: string | null;
  status: string;
  housekeepingStatus: string | null;
  maintenanceStatus: string | null;
  sellable: boolean;
  active: boolean;
  sortOrder: number | null;
}): RoomRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    number: row.number,
    floor: row.floor ?? "",
    status: row.status as RoomRecord["status"],
    housekeepingStatus: (row.housekeepingStatus ?? row.status) as RoomRecord["housekeepingStatus"],
    maintenanceStatus: (row.maintenanceStatus ?? "ok") as RoomRecord["maintenanceStatus"],
    sellable: row.sellable,
    active: row.active,
    sortOrder: row.sortOrder ?? 0
  };
}

export async function getHousekeepingBoard(propertyId: string): Promise<HousekeepingBoardItem[]> {
  // Read the REAL room inventory + open tasks from Prisma so the board reflects
  // every room and every persisted task (not just the small in-memory demo set).
  const [rooms, openTasks] = await Promise.all([
    prisma.room.findMany({
      where: { propertyId, active: true },
      select: {
        id: true,
        propertyId: true,
        roomTypeId: true,
        number: true,
        floor: true,
        status: true,
        housekeepingStatus: true,
        maintenanceStatus: true,
        sellable: true,
        active: true,
        sortOrder: true
      },
      orderBy: { number: "asc" },
      // Hot-fix: a property has at most a few hundred rooms; cap defensively.
      take: 2000
    }),
    // Hot-fix: cap to 1000 open tasks. A healthy operation should never have
    // more than a few hundred open at once; this is an upper bound so the
    // board render cannot accidentally pull the full table.
    prisma.housekeepingTask.findMany({ where: { propertyId, status: { not: "done" } }, take: 1000 })
  ]);

  const byRoom = new Map<string, HousekeepingTaskRecord[]>();
  for (const t of openTasks) {
    const arr = byRoom.get(t.roomId) ?? [];
    arr.push(mapTask(t));
    byRoom.set(t.roomId, arr);
  }

  return rooms.map((room) => ({ room: mapRoom(room), tasks: byRoom.get(room.id) ?? [] }));
}

export async function createHousekeepingTask(input: {
  context: UserContext;
  propertyId: string;
  roomId: string;
  taskType: HousekeepingTaskRecord["taskType"];
  priority?: HousekeepingTaskRecord["priority"];
  assignedTo?: string;
  dueAt?: string;
  correlationId: string;
}): Promise<HousekeepingTaskRecord> {
  requirePermissions(input.context, ["housekeeping.task.manage"]);

  const room = await prisma.room.findFirst({
    where: { id: input.roomId, propertyId: input.propertyId },
    select: { id: true }
  });
  if (!room) {
    throw new NotFoundError("Room was not found.");
  }

  const created = await prisma.housekeepingTask.create({
    data: {
      propertyId: input.propertyId,
      roomId: input.roomId,
      taskType: input.taskType,
      priority: input.priority ?? "normal",
      status: input.assignedTo ? "assigned" : "pending",
      assignedTo: input.assignedTo ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null
    }
  });
  const task = mapTask(created);
  mirrorTask(task);

  await recordHousekeepingEvent({
    taskId: task.id,
    eventType: "created",
    note: `${task.taskType} task created.`,
    createdBy: input.context.userId
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HOUSEKEEPING_TASK_CREATED",
    entityType: "housekeeping_task",
    entityId: task.id,
    afterJson: task,
    correlationId: input.correlationId
  });

  return task;
}

export async function createDepartureCleaningTask(input: {
  context: UserContext;
  propertyId: string;
  roomId: string;
  correlationId: string;
}): Promise<HousekeepingTaskRecord> {
  return createHousekeepingTask({
    context: input.context,
    propertyId: input.propertyId,
    roomId: input.roomId,
    taskType: "departure_clean",
    priority: "high",
    correlationId: input.correlationId
  });
}

export async function updateHousekeepingTask(input: {
  context: UserContext;
  taskId: string;
  patch: Partial<Pick<HousekeepingTaskRecord, "status" | "priority" | "assignedTo" | "dueAt">>;
  note?: string;
  correlationId: string;
}): Promise<HousekeepingTaskRecord> {
  requirePermissions(input.context, ["housekeeping.task.manage"]);

  // Race-condition fix: read + mutate in a single transaction so a concurrent
  // updateHousekeepingTask (or HK mobile sync) cannot overwrite our changes
  // between the findUnique and the update.
  const { before, task } = await prisma.$transaction(async (tx) => {
    const existing = await tx.housekeepingTask.findUnique({ where: { id: input.taskId } });
    if (!existing) {
      throw new NotFoundError("Housekeeping task was not found.");
    }
    const updated = await tx.housekeepingTask.update({
      where: { id: input.taskId },
      data: {
        ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
        ...(input.patch.priority !== undefined ? { priority: input.patch.priority } : {}),
        ...(input.patch.assignedTo !== undefined ? { assignedTo: input.patch.assignedTo ?? null } : {}),
        ...(input.patch.dueAt !== undefined ? { dueAt: input.patch.dueAt ? new Date(input.patch.dueAt) : null } : {})
      }
    });
    return { before: mapTask(existing), task: mapTask(updated) };
  });
  mirrorTask(task);

  await recordHousekeepingEvent({
    taskId: task.id,
    eventType: task.status === "done" ? "done" : task.status === "rejected" ? "rejected" : "assigned",
    note: input.note,
    createdBy: input.context.userId
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: task.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HOUSEKEEPING_TASK_UPDATED",
    entityType: "housekeeping_task",
    entityId: task.id,
    beforeJson: before,
    afterJson: task,
    correlationId: input.correlationId
  });

  return task;
}

export async function addHousekeepingPhoto(input: {
  context: UserContext;
  taskId: string;
  objectKey: string;
  note?: string;
  correlationId: string;
}): Promise<HousekeepingEventRecord> {
  requirePermissions(input.context, ["housekeeping.task.manage"]);

  const task = await prisma.housekeepingTask.findUnique({ where: { id: input.taskId } });
  if (!task) {
    throw new NotFoundError("Housekeeping task was not found.");
  }

  const event = await recordHousekeepingEvent({
    taskId: task.id,
    eventType: "photo_added",
    note: input.note,
    photoObjectKey: input.objectKey,
    createdBy: input.context.userId
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: task.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HOUSEKEEPING_PHOTO_ADDED",
    entityType: "housekeeping_event",
    entityId: event.id,
    afterJson: event,
    correlationId: input.correlationId
  });

  return event;
}

export async function markRoomClean(input: {
  context: UserContext;
  roomId: string;
  correlationId: string;
}): Promise<RoomRecord> {
  requirePermissions(input.context, ["housekeeping.task.manage"]);
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) {
    throw new NotFoundError("Room was not found.");
  }

  await prisma.room.update({
    where: { id: room.id },
    data: { housekeepingStatus: "clean", status: "clean" }
  });
  mirrorRoomStatus(room.id, { housekeepingStatus: "clean", status: "clean" });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: room.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_MARKED_CLEAN",
    entityType: "room",
    entityId: room.id,
    afterJson: { housekeepingStatus: "clean", status: "clean" },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: room.propertyId,
    entityType: "room",
    entityId: room.id,
    eventType: "RoomMarkedClean",
    payload: { roomNumber: room.number },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return demoStore.rooms.find((r) => r.id === room.id) ?? ({ id: room.id, propertyId: room.propertyId, roomTypeId: room.roomTypeId, number: room.number, floor: room.floor ?? "", status: "clean", housekeepingStatus: "clean", maintenanceStatus: (room.maintenanceStatus ?? "ok") as RoomRecord["maintenanceStatus"], sellable: room.sellable, active: room.active, sortOrder: room.sortOrder } as RoomRecord);
}

export async function markRoomInspected(input: {
  context: UserContext;
  roomId: string;
  correlationId: string;
}): Promise<RoomRecord> {
  requirePermissions(input.context, ["housekeeping.task.manage"]);
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) {
    throw new NotFoundError("Room was not found.");
  }
  // A room counts as clean if either its HK status or its room status is "clean"
  // (seed rooms may only carry status). Mirrors the board's display logic.
  if ((room.housekeepingStatus ?? room.status ?? "") !== "clean") {
    throw new NotFoundError("Solo se pueden inspeccionar habitaciones limpias.");
  }

  await prisma.room.update({
    where: { id: room.id },
    data: { housekeepingStatus: "inspected", status: "inspected" }
  });
  mirrorRoomStatus(room.id, { housekeepingStatus: "inspected", status: "inspected" });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: room.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_INSPECTED",
    entityType: "room",
    entityId: room.id,
    afterJson: { housekeepingStatus: "inspected", status: "inspected" },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: room.propertyId,
    entityType: "room",
    entityId: room.id,
    eventType: "RoomInspected",
    payload: { roomNumber: room.number },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return demoStore.rooms.find((r) => r.id === room.id) ?? ({ id: room.id, propertyId: room.propertyId, roomTypeId: room.roomTypeId, number: room.number, floor: room.floor ?? "", status: "inspected", housekeepingStatus: "inspected", maintenanceStatus: (room.maintenanceStatus ?? "ok") as RoomRecord["maintenanceStatus"], sellable: room.sellable, active: room.active, sortOrder: room.sortOrder } as RoomRecord);
}

async function recordHousekeepingEvent(input: {
  taskId: string;
  eventType: HousekeepingEventRecord["eventType"];
  note?: string;
  photoObjectKey?: string;
  createdBy?: string;
}): Promise<HousekeepingEventRecord> {
  const created = await prisma.housekeepingEvent.create({
    data: {
      taskId: input.taskId,
      eventType: input.eventType,
      note: input.note ?? null,
      photoObjectKey: input.photoObjectKey ?? null,
      createdBy: input.createdBy ?? null
    }
  });
  const event: HousekeepingEventRecord = {
    id: created.id,
    taskId: created.taskId,
    eventType: created.eventType as HousekeepingEventRecord["eventType"],
    note: created.note ?? undefined,
    photoObjectKey: created.photoObjectKey ?? undefined,
    createdBy: created.createdBy ?? undefined,
    createdAt: created.createdAt.toISOString()
  };
  demoStore.housekeepingEvents.push(event);
  return event;
}
