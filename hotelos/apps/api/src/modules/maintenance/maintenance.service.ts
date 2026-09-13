import { prisma } from "@hotelos/database";
import { demoStore, type UserContext, type WorkOrderMediaRecord, type WorkOrderRecord } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { isPlatformAdmin, requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/http-error.js";

// Maintenance work orders now PERSIST TO PRISMA (work_orders / work_order_media /
// rooms) so the Prisma-backed maintenance dashboard reflects them. Previously
// these wrote only to the in-memory demo store. We keep a best-effort demo-store
// mirror for room status so legacy demo readers stay consistent.

type PrismaWorkOrder = {
  id: string;
  propertyId: string;
  roomId: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  blocksRoom: boolean;
  createdBy: string | null;
  assignedTo: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

function mapOrder(row: PrismaWorkOrder): WorkOrderRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    priority: row.priority as WorkOrderRecord["priority"],
    status: row.status as WorkOrderRecord["status"],
    blocksRoom: row.blocksRoom,
    createdBy: row.createdBy ?? undefined,
    assignedTo: row.assignedTo ?? undefined,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : undefined
  };
}

function mirrorOrder(order: WorkOrderRecord): void {
  const idx = demoStore.workOrders.findIndex((o) => o.id === order.id);
  if (idx >= 0) demoStore.workOrders[idx] = order;
  else demoStore.workOrders.push(order);
}

function mirrorRoomStatus(roomId: string, patch: Record<string, unknown>): void {
  const room = demoStore.rooms.find((r) => r.id === roomId);
  if (room) Object.assign(room, patch);
}

// ---------------------------------------------------------------------------
// HK-04 guards
// ---------------------------------------------------------------------------

// Enum guards (HK-04c). `WorkOrder.status` is a Prisma enum, so an out-of-range
// value used to surface as a PrismaClientValidationError (500). `priority` and
// `WorkOrderMedia.mediaType` are plain String columns; we validate them against
// the domain literals anyway so garbage never gets persisted.
const WO_STATUSES: readonly WorkOrderRecord["status"][] = ["open", "assigned", "in_progress", "waiting_vendor", "resolved", "closed"];
const WO_PRIORITIES: readonly WorkOrderRecord["priority"][] = ["emergency", "urgent", "normal", "preventive"];
const WO_MEDIA_TYPES: readonly WorkOrderMediaRecord["mediaType"][] = ["photo", "video"];
// Terminal states (HK-04b): a resolved/closed order is not transitioned again.
const WO_TERMINAL_STATUSES: readonly string[] = ["resolved", "closed"];

function assertEnumValue(prefix: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new BadRequestError(`${prefix}: ${String(value)}. Valores admitidos: ${allowed.join(", ")}.`);
  }
}

// Input-shape guards. Handlers cast `request.body` without a schema, so any
// field forwarded raw to Prisma (free text, flags) used to surface a
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

function assertBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") throw new BadRequestError(`${label} debe ser verdadero o falso.`);
}

// Tenancy guard (HK-04a). Work orders carry no Prisma relation to Property, so
// we resolve the row by id and then confirm its property belongs to the caller's
// organization. "Missing" and "foreign" collapse into the same 404 — resolved
// BEFORE any business rule — so a caller from another tenant can neither confirm
// existence nor learn the state of orders it doesn't own.
// Exception: a platform admin (admin.tenants.manage granted through REAL DB
// roles, never the demo union) may act across organizations, mirroring the
// global `:propertyId` hook in server.ts. A missing row is still a 404 for
// everyone.

// `context.isPlatformAdmin` is trusted when the auth layer has stamped it; when
// absent we fall back to the DB-backed check. Only reached for foreign
// resources, so regular in-org callers never pay the extra lookup.
async function callerIsPlatformAdmin(context: UserContext): Promise<boolean> {
  if (context.isPlatformAdmin !== undefined) return context.isPlatformAdmin === true;
  return isPlatformAdmin(context);
}

async function canAccessProperty(propertyId: string, context: UserContext): Promise<boolean> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) return false;
  if (property.organizationId === context.organizationId) return true;
  return callerIsPlatformAdmin(context);
}

async function findWorkOrderInOrg(workOrderId: string, context: UserContext) {
  const order = await prisma.workOrder.findUnique({ where: { id: workOrderId } });
  if (!order || !(await canAccessProperty(order.propertyId, context))) {
    throw new NotFoundError("Orden de trabajo no encontrada.");
  }
  return order;
}

export async function listWorkOrders(
  propertyId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<WorkOrderRecord[]> {
  // Hot-fix: cap response size so a property with thousands of historic work
  // orders cannot blow up the response payload / API memory. Default 100,
  // hard ceiling 500, with optional offset for paging through history.
  const take = Math.min(500, Math.max(1, options.limit ?? 100));
  const skip = Math.max(0, options.offset ?? 0);
  const rows = await prisma.workOrder.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take,
    skip
  });
  return rows.map(mapOrder);
}

export async function createWorkOrder(input: {
  context: UserContext;
  roomNumber?: string;
  title: string;
  description?: string;
  priority: WorkOrderRecord["priority"];
  blocksRoom: boolean;
  correlationId: string;
}): Promise<WorkOrderRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage"]);
  // Body-only guards run first (HK-04c): they leak nothing about the rows and
  // keep Prisma from throwing a 500 on a malformed request.
  assertRequiredString("El título", input.title);
  assertOptionalString("El número de habitación", input.roomNumber);
  assertOptionalString("La descripción", input.description);
  assertBoolean("El campo blocksRoom", input.blocksRoom);
  assertEnumValue("Prioridad no válida", input.priority, WO_PRIORITIES);

  const room = input.roomNumber
    ? await prisma.room.findFirst({
        where: { propertyId: input.context.propertyId, number: input.roomNumber },
        select: { id: true, number: true }
      })
    : null;

  if (input.blocksRoom && !input.context.permissions.includes("ai.high_risk.confirm")) {
    throw new ForbiddenError("Blocking a room requires manager or maintenance lead confirmation.");
  }

  const created = await prisma.workOrder.create({
    data: {
      propertyId: input.context.propertyId,
      roomId: room?.id ?? null,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      status: "open",
      blocksRoom: input.blocksRoom,
      createdBy: input.context.userId
    }
  });
  const order = mapOrder(created);
  mirrorOrder(order);

  if (input.blocksRoom && room) {
    await prisma.room.update({
      where: { id: room.id },
      data: { sellable: false, maintenanceStatus: "blocked", status: "out_of_order" }
    });
    mirrorRoomStatus(room.id, { sellable: false, maintenanceStatus: "blocked", status: "out_of_order" });
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_CREATED",
    entityType: "work_order",
    entityId: order.id,
    afterJson: order,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "work_order",
    entityId: order.id,
    eventType: input.blocksRoom ? "RoomBlocked" : "WorkOrderCreated",
    payload: { roomId: room?.id, roomNumber: room?.number, priority: order.priority },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return order;
}

export async function updateWorkOrder(input: {
  context: UserContext;
  workOrderId: string;
  patch: Partial<Pick<WorkOrderRecord, "title" | "description" | "priority" | "status" | "assignedTo">>;
  correlationId: string;
}): Promise<WorkOrderRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage"]);
  // Enum guards (HK-04c) run first: they only look at the request body, so they
  // leak nothing about the order, and they keep Prisma from throwing a 500.
  if (input.patch.status !== undefined) assertEnumValue("Estado no válido", input.patch.status, WO_STATUSES);
  if (input.patch.priority !== undefined) assertEnumValue("Prioridad no válida", input.patch.priority, WO_PRIORITIES);
  // `title` is NOT NULL in Prisma, so a present title must be a non-empty
  // string; `description` / `assignedTo` are nullable and accept null to clear.
  if (input.patch.title !== undefined) assertRequiredString("El título", input.patch.title);
  assertOptionalString("La descripción", input.patch.description);
  assertOptionalString("El campo assignedTo", input.patch.assignedTo);

  // Tenancy (HK-04a) before any business rule.
  const existing = await findWorkOrderInOrg(input.workOrderId, input.context);
  const before = mapOrder(existing);

  // Transition guard (HK-04b): once resolved/closed the order is terminal. There
  // is no explicit reopen flow, so a status change out of a terminal state is
  // rejected; the only forward move allowed is resolved → closed.
  if (input.patch.status !== undefined && WO_TERMINAL_STATUSES.includes(existing.status)) {
    const closingResolved = existing.status === "resolved" && input.patch.status === "closed";
    if (!closingResolved) throw new ConflictError("La orden ya está resuelta.");
  }
  // A PATCH that moves the order into a terminal state stamps resolvedAt, the
  // same way resolveWorkOrder does, so dashboards see a consistent record.
  const stampResolvedAt =
    input.patch.status !== undefined && WO_TERMINAL_STATUSES.includes(input.patch.status) && !existing.resolvedAt;

  const updated = await prisma.workOrder.update({
    where: { id: input.workOrderId },
    data: {
      ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
      ...(input.patch.description !== undefined ? { description: input.patch.description ?? null } : {}),
      ...(input.patch.priority !== undefined ? { priority: input.patch.priority } : {}),
      ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
      ...(stampResolvedAt ? { resolvedAt: new Date() } : {}),
      ...(input.patch.assignedTo !== undefined ? { assignedTo: input.patch.assignedTo ?? null } : {})
    }
  });
  const order = mapOrder(updated);
  mirrorOrder(order);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_UPDATED",
    entityType: "work_order",
    entityId: order.id,
    beforeJson: before,
    afterJson: order,
    correlationId: input.correlationId
  });

  return order;
}

export async function attachWorkOrderMedia(input: {
  context: UserContext;
  workOrderId: string;
  objectKey: string;
  mediaType: WorkOrderMediaRecord["mediaType"];
  correlationId: string;
}): Promise<WorkOrderMediaRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage"]);
  assertEnumValue("Tipo de archivo no válido", input.mediaType, WO_MEDIA_TYPES);
  assertRequiredString("La clave del archivo (objectKey)", input.objectKey);

  // Tenancy (HK-04a): scoped lookup before writing the media row.
  const order = await findWorkOrderInOrg(input.workOrderId, input.context);

  const created = await prisma.workOrderMedia.create({
    data: { workOrderId: order.id, objectKey: input.objectKey, mediaType: input.mediaType }
  });
  const media: WorkOrderMediaRecord = {
    id: created.id,
    workOrderId: created.workOrderId,
    objectKey: created.objectKey,
    mediaType: created.mediaType as WorkOrderMediaRecord["mediaType"]
  };
  demoStore.workOrderMedia.push(media);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_MEDIA_ATTACHED",
    entityType: "work_order_media",
    entityId: media.id,
    afterJson: media,
    correlationId: input.correlationId
  });

  return media;
}

export async function blockRoomForMaintenance(input: {
  context: UserContext;
  workOrderId: string;
  correlationId: string;
}): Promise<WorkOrderRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage", "ai.high_risk.confirm"]);

  // Tenancy (HK-04a) before any business rule.
  const existing = await findWorkOrderInOrg(input.workOrderId, input.context);
  if (!existing.roomId) {
    throw new BadRequestError("La orden de trabajo no está vinculada a ninguna habitación.");
  }
  // Idempotency guard: a second block-room on an order that already blocks its
  // room used to return 200 and emit a duplicate RoomBlocked domain event.
  if (existing.blocksRoom) {
    throw new ConflictError("La habitación ya está bloqueada por esta orden.");
  }
  const room = await prisma.room.findUnique({ where: { id: existing.roomId } });
  if (!room) throw new NotFoundError("Habitación no encontrada.");

  const before = mapOrder(existing);
  const updated = await prisma.workOrder.update({ where: { id: existing.id }, data: { blocksRoom: true } });
  await prisma.room.update({
    where: { id: room.id },
    data: { sellable: false, maintenanceStatus: "blocked", status: "out_of_order" }
  });
  mirrorRoomStatus(room.id, { sellable: false, maintenanceStatus: "blocked", status: "out_of_order" });
  const order = mapOrder(updated);
  mirrorOrder(order);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_BLOCKED_FOR_MAINTENANCE",
    entityType: "work_order",
    entityId: order.id,
    beforeJson: before,
    afterJson: { order, roomId: room.id },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    entityType: "room",
    entityId: room.id,
    eventType: "RoomBlocked",
    payload: { workOrderId: order.id, roomNumber: room.number },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return order;
}

export async function resolveWorkOrder(input: {
  context: UserContext;
  workOrderId: string;
  resolutionNote?: string;
  releaseRoom?: boolean;
  correlationId: string;
}): Promise<WorkOrderRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage"]);

  // Tenancy (HK-04a) before any business rule.
  const existing = await findWorkOrderInOrg(input.workOrderId, input.context);
  // Transition guard (HK-04b): resolving an already resolved/closed order used to
  // return 200, re-stamp resolvedAt and emit a duplicate WorkOrderResolved event.
  if (WO_TERMINAL_STATUSES.includes(existing.status)) {
    throw new ConflictError("La orden ya está resuelta.");
  }
  const room = existing.roomId ? await prisma.room.findUnique({ where: { id: existing.roomId } }) : null;
  const before = mapOrder(existing);

  const updated = await prisma.workOrder.update({
    where: { id: existing.id },
    data: { status: "resolved", resolvedAt: new Date() }
  });

  if (input.releaseRoom && room) {
    const nextStatus = room.status === "out_of_order" ? "dirty" : room.status;
    await prisma.room.update({
      where: { id: room.id },
      data: {
        sellable: true,
        maintenanceStatus: "ok",
        status: nextStatus,
        ...(room.status === "out_of_order" ? { housekeepingStatus: "dirty" } : {})
      }
    });
    mirrorRoomStatus(room.id, {
      sellable: true,
      maintenanceStatus: "ok",
      status: nextStatus,
      ...(room.status === "out_of_order" ? { housekeepingStatus: "dirty" } : {})
    });
  }
  const order = mapOrder(updated);
  mirrorOrder(order);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_RESOLVED",
    entityType: "work_order",
    entityId: order.id,
    beforeJson: before,
    afterJson: { order, resolutionNote: input.resolutionNote },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    entityType: "work_order",
    entityId: order.id,
    eventType: "WorkOrderResolved",
    payload: { roomId: order.roomId, releaseRoom: input.releaseRoom ?? false },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return order;
}
