import { prisma } from "@hotelos/database";
import {
  demoStore,
  type HousekeepingEventRecord,
  type HousekeepingTaskRecord,
  type RoomRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { isPlatformAdmin, requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";

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

// ---------------------------------------------------------------------------
// HK-04 guards
// ---------------------------------------------------------------------------

// Enum guards (HK-04c). `HousekeepingTask.status` is a Prisma enum, so an
// out-of-range value used to surface as a PrismaClientValidationError (500).
// `priority` / `taskType` are plain String columns; we validate them against the
// domain literals anyway so garbage never gets persisted.
const HK_TASK_STATUSES: readonly HousekeepingTaskRecord["status"][] = ["pending", "assigned", "in_progress", "done", "rejected"];
const HK_TASK_PRIORITIES: readonly HousekeepingTaskRecord["priority"][] = ["low", "normal", "high"];
const HK_TASK_TYPES: readonly HousekeepingTaskRecord["taskType"][] = ["departure_clean", "stayover", "inspection", "deep_clean"];
// Terminal states (HK-04b): a done/rejected task is not transitioned again.
const HK_TERMINAL_STATUSES: readonly string[] = ["done", "rejected"];

function assertEnumValue(prefix: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new BadRequestError(`${prefix}: ${String(value)}. Valores admitidos: ${allowed.join(", ")}.`);
  }
}

// Input-shape guards. Handlers cast `request.body` without a schema, so any
// field forwarded raw to Prisma (ids, free text, dates) used to surface a
// PrismaClientValidationError (500) when the client sent the wrong type.
// `null` is accepted wherever the column is nullable (it clears the value).
function assertRequiredString(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${label} es obligatorio.`);
  }
}

function assertOptionalString(label: string, value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new BadRequestError(`${label} debe ser texto.`);
  }
}

// `dueAt` is a DateTime column: `new Date("garbage")` yields an Invalid Date
// that Prisma rejects with a 500. Empty/null clears the deadline.
function parseDueAt(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new BadRequestError("Fecha límite no válida.");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestError("Fecha límite no válida.");
  return date;
}

// Tenancy guards (HK-04a). Rooms and tasks carry no Prisma relation to Property,
// so we resolve the row by id and then confirm its property belongs to the
// caller's organization. "Missing" and "foreign" collapse into the same 404 —
// resolved BEFORE any business rule — so a caller from another tenant can
// neither confirm existence nor learn the state of rows it doesn't own.
// Exception: a platform admin (admin.tenants.manage granted through REAL DB
// roles, never the demo union) may act across organizations, mirroring the
// global `:propertyId` hook in server.ts. A missing row is still a 404 for
// everyone. Accepts either the root client or a `$transaction` client.
type HkDb = Pick<typeof prisma, "property" | "room" | "housekeepingTask">;

// `context.isPlatformAdmin` is trusted when the auth layer has stamped it; when
// absent we fall back to the DB-backed check. Only reached for foreign
// resources, so regular in-org callers never pay the extra lookup.
async function callerIsPlatformAdmin(context: UserContext): Promise<boolean> {
  if (context.isPlatformAdmin !== undefined) return context.isPlatformAdmin === true;
  return isPlatformAdmin(context);
}

async function canAccessProperty(db: HkDb, propertyId: string, context: UserContext): Promise<boolean> {
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) return false;
  if (property.organizationId === context.organizationId) return true;
  return callerIsPlatformAdmin(context);
}

async function findRoomInOrg(db: HkDb, roomId: string, context: UserContext) {
  const room = await db.room.findUnique({ where: { id: roomId } });
  if (!room || !(await canAccessProperty(db, room.propertyId, context))) {
    throw new NotFoundError("Habitación no encontrada.");
  }
  return room;
}

async function findTaskInOrg(db: HkDb, taskId: string, context: UserContext) {
  const task = await db.housekeepingTask.findUnique({ where: { id: taskId } });
  if (!task || !(await canAccessProperty(db, task.propertyId, context))) {
    throw new NotFoundError("Tarea de limpieza no encontrada.");
  }
  return task;
}

// Status → housekeeping_event literal. `pending` has no dedicated literal (it
// only means "unassigned"), so a move back to pending records no status event;
// the audit trail still captures it via HOUSEKEEPING_TASK_UPDATED.
function statusEventFor(status: string): HousekeepingEventRecord["eventType"] | undefined {
  switch (status) {
    case "done":
      return "done";
    case "rejected":
      return "rejected";
    case "in_progress":
      return "started";
    case "assigned":
      return "assigned";
    default:
      return undefined;
  }
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
  // Body-only guards run first (HK-04c): they leak nothing about the rows and
  // keep Prisma from throwing a 500 on a malformed request.
  assertRequiredString("El identificador de propiedad", input.propertyId);
  assertRequiredString("El identificador de habitación", input.roomId);
  assertEnumValue("Tipo de tarea no válido", input.taskType, HK_TASK_TYPES);
  if (input.priority !== undefined) assertEnumValue("Prioridad no válida", input.priority, HK_TASK_PRIORITIES);
  assertOptionalString("El campo assignedTo", input.assignedTo);
  const dueAt = parseDueAt(input.dueAt);

  // Tenancy (HK-04a): the room must exist in the requested property AND that
  // property must belong to the caller's organization — a foreign propertyId in
  // the body must not let a caller create tasks in another tenant's property.
  // A platform admin may target any org's property (same 404 if it's missing).
  const room = await prisma.room.findFirst({
    where: { id: input.roomId, propertyId: input.propertyId },
    select: { id: true }
  });
  if (!room || !(await canAccessProperty(prisma, input.propertyId, input.context))) {
    throw new NotFoundError("Habitación no encontrada.");
  }

  const created = await prisma.housekeepingTask.create({
    data: {
      propertyId: input.propertyId,
      roomId: input.roomId,
      taskType: input.taskType,
      priority: input.priority ?? "normal",
      status: input.assignedTo ? "assigned" : "pending",
      assignedTo: input.assignedTo ?? null,
      dueAt
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

// ---------------------------------------------------------------------------
// System-originated tasks (Tanda 2 · REC-03)
// ---------------------------------------------------------------------------

// Delegates the system variant can run on: the root client or a `$transaction`
// client, so a room move can create the departure-clean task atomically with
// the room/Stay updates.
type HkTaskDb = Pick<typeof prisma, "room" | "housekeepingTask" | "housekeepingEvent">;

// Open tasks that make a new one of the same type redundant for a room.
const HK_OPEN_STATUSES: readonly HousekeepingTaskRecord["status"][] = ["pending", "assigned"];

export type SystemHousekeepingTaskInput = {
  /** Root client by default; pass the `$transaction` client to join a transaction. */
  db?: HkTaskDb;
  organizationId: string;
  propertyId: string;
  roomId: string;
  taskType: HousekeepingTaskRecord["taskType"];
  priority?: HousekeepingTaskRecord["priority"];
  dueAt?: Date | null;
  /** User whose front-desk action triggered the task (audit actor); absent → system. */
  actorUserId?: string;
  /** Free-text note stored on the `created` housekeeping event. */
  reason?: string;
  correlationId: string;
};

export type SystemHousekeepingTaskResult = {
  task: HousekeepingTaskRecord;
  /** false when an open (pending/assigned) task of the same type already covered the room. */
  created: boolean;
};

/**
 * Create a housekeeping task as a SIDE EFFECT of a front-desk operation
 * (check-out, in-house room move) WITHOUT `housekeeping.task.manage`: the
 * receptionist role does not hold that permission (packages/shared
 * permissions.ts), so routing these through `createHousekeepingTask` made the
 * primary operation succeed and then fail on the follow-up task under strict
 * RBAC. Tenancy is the CALLER's responsibility (the reservation/room was
 * already access-checked); this helper only verifies the room exists in the
 * given property. Dedup: an open (pending/assigned) task of the same type for
 * the same room is returned instead of creating a duplicate.
 */
export async function createSystemHousekeepingTask(input: SystemHousekeepingTaskInput): Promise<SystemHousekeepingTaskResult> {
  const db = input.db ?? prisma;
  assertRequiredString("El identificador de propiedad", input.propertyId);
  assertRequiredString("El identificador de habitación", input.roomId);
  assertEnumValue("Tipo de tarea no válido", input.taskType, HK_TASK_TYPES);
  if (input.priority !== undefined) assertEnumValue("Prioridad no válida", input.priority, HK_TASK_PRIORITIES);

  const room = await db.room.findFirst({
    where: { id: input.roomId, propertyId: input.propertyId },
    select: { id: true }
  });
  if (!room) {
    throw new NotFoundError("Habitación no encontrada.");
  }

  const existing = await db.housekeepingTask.findFirst({
    where: { propertyId: input.propertyId, roomId: input.roomId, taskType: input.taskType, status: { in: [...HK_OPEN_STATUSES] } },
    orderBy: { createdAt: "asc" }
  });
  if (existing) {
    const task = mapTask(existing);
    mirrorTask(task);
    return { task, created: false };
  }

  const created = await db.housekeepingTask.create({
    data: {
      propertyId: input.propertyId,
      roomId: input.roomId,
      taskType: input.taskType,
      priority: input.priority ?? "normal",
      status: "pending",
      assignedTo: null,
      dueAt: input.dueAt ?? null
    }
  });
  const task = mapTask(created);
  mirrorTask(task);

  await recordHousekeepingEvent({
    db,
    taskId: task.id,
    eventType: "created",
    note: input.reason ?? `${task.taskType} task created.`,
    createdBy: input.actorUserId
  });

  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.actorUserId,
    actorType: input.actorUserId ? "user" : "system",
    action: "HOUSEKEEPING_TASK_CREATED",
    entityType: "housekeeping_task",
    entityId: task.id,
    afterJson: { ...task, reason: input.reason ?? null },
    correlationId: input.correlationId
  });

  return { task, created: true };
}

/**
 * Departure-clean task after a check-out. Tenancy is still enforced (the
 * property must be in the caller's org, or the caller is a platform admin) but
 * NO housekeeping permission is required: this is the automatic consequence
 * of `pms.checkout.execute`, not a manual HK action. Idempotent per room.
 */
export async function createDepartureCleaningTask(input: {
  context: UserContext;
  propertyId: string;
  roomId: string;
  correlationId: string;
}): Promise<HousekeepingTaskRecord> {
  assertRequiredString("El identificador de propiedad", input.propertyId);
  if (!(await canAccessProperty(prisma, input.propertyId, input.context))) {
    throw new NotFoundError("Habitación no encontrada.");
  }
  const { task } = await createSystemHousekeepingTask({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    roomId: input.roomId,
    taskType: "departure_clean",
    priority: "high",
    actorUserId: input.context.userId,
    reason: "Departure clean after check-out.",
    correlationId: input.correlationId
  });
  return task;
}

export async function updateHousekeepingTask(input: {
  context: UserContext;
  taskId: string;
  patch: Partial<Pick<HousekeepingTaskRecord, "status" | "priority" | "assignedTo" | "dueAt">>;
  note?: string;
  correlationId: string;
}): Promise<HousekeepingTaskRecord> {
  requirePermissions(input.context, ["housekeeping.task.manage"]);
  // Enum guards (HK-04c) run first: they only look at the request body, so they
  // leak nothing about the task, and they keep Prisma from throwing a 500.
  if (input.patch.status !== undefined) assertEnumValue("Estado no válido", input.patch.status, HK_TASK_STATUSES);
  if (input.patch.priority !== undefined) assertEnumValue("Prioridad no válida", input.patch.priority, HK_TASK_PRIORITIES);
  assertOptionalString("El campo assignedTo", input.patch.assignedTo);
  assertOptionalString("La nota", input.note);
  const dueAt = input.patch.dueAt !== undefined ? parseDueAt(input.patch.dueAt) : undefined;

  // Race-condition fix: read + mutate in a single transaction so a concurrent
  // updateHousekeepingTask (or HK mobile sync) cannot overwrite our changes
  // between the lookup and the update.
  const { before, task, statusChanged, assigneeChanged } = await prisma.$transaction(async (tx) => {
    // Tenancy (HK-04a) before any business rule.
    const existing = await findTaskInOrg(tx, input.taskId, input.context);
    // Transition guard (HK-04b): a finished task cannot be transitioned again.
    // Previously a second PATCH status=done returned 200 and logged a duplicate
    // 'done' event.
    if (input.patch.status !== undefined && HK_TERMINAL_STATUSES.includes(existing.status)) {
      throw new ConflictError("La tarea ya está finalizada.");
    }
    const updated = await tx.housekeepingTask.update({
      where: { id: input.taskId },
      data: {
        ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
        ...(input.patch.priority !== undefined ? { priority: input.patch.priority } : {}),
        ...(input.patch.assignedTo !== undefined ? { assignedTo: input.patch.assignedTo ?? null } : {}),
        ...(dueAt !== undefined ? { dueAt } : {})
      }
    });
    return {
      before: mapTask(existing),
      task: mapTask(updated),
      // Compared against the pre-update row so events reflect REAL transitions.
      statusChanged: input.patch.status !== undefined && input.patch.status !== existing.status,
      assigneeChanged: input.patch.assignedTo !== undefined && (input.patch.assignedTo ?? null) !== existing.assignedTo
    };
  });
  mirrorTask(task);

  // Housekeeping events describe transitions, not PATCH calls: a status event
  // only when the status actually changed (previously PATCH {priority} on a done
  // task re-logged 'done'), and 'assigned' only when the assignee changed. A
  // status move to in_progress logs 'started'. The optional note rides on the
  // first event recorded.
  const eventTypes: HousekeepingEventRecord["eventType"][] = [];
  if (statusChanged) {
    const statusEvent = statusEventFor(task.status);
    if (statusEvent) eventTypes.push(statusEvent);
  }
  if (assigneeChanged && !eventTypes.includes("assigned")) eventTypes.push("assigned");
  for (const [index, eventType] of eventTypes.entries()) {
    await recordHousekeepingEvent({
      taskId: task.id,
      eventType,
      note: index === 0 ? input.note ?? undefined : undefined,
      createdBy: input.context.userId
    });
  }

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
  assertRequiredString("La clave del archivo (objectKey)", input.objectKey);
  assertOptionalString("La nota", input.note);

  // Tenancy (HK-04a): scoped lookup before writing the photo event.
  const task = await findTaskInOrg(prisma, input.taskId, input.context);

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
  // Tenancy (HK-04a): org-scoped lookup before any write.
  const room = await findRoomInOrg(prisma, input.roomId, input.context);

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
  // Tenancy (HK-04a) BEFORE the state rule below: a caller from another org must
  // get the same 404 whether the room is missing, dirty or clean — otherwise the
  // 409 would confirm existence and state of a room it doesn't own.
  const room = await findRoomInOrg(prisma, input.roomId, input.context);
  // A room counts as clean if either its HK status or its room status is "clean"
  // (seed rooms may only carry status). Mirrors the board's display logic.
  if ((room.housekeepingStatus ?? room.status ?? "") !== "clean") {
    throw new ConflictError("Solo se pueden inspeccionar habitaciones limpias.");
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
  /** Root client by default; a `$transaction` client keeps the event atomic with its task. */
  db?: Pick<typeof prisma, "housekeepingEvent">;
  taskId: string;
  eventType: HousekeepingEventRecord["eventType"];
  note?: string;
  photoObjectKey?: string;
  createdBy?: string;
}): Promise<HousekeepingEventRecord> {
  const created = await (input.db ?? prisma).housekeepingEvent.create({
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
