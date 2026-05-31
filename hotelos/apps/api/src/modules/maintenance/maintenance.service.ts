import { prisma } from "@hotelos/database";
import { demoStore, type UserContext, type WorkOrderMediaRecord, type WorkOrderRecord } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/http-error.js";

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

  const existing = await prisma.workOrder.findUnique({ where: { id: input.workOrderId } });
  if (!existing) throw new NotFoundError("Work order was not found.");
  const before = mapOrder(existing);

  const updated = await prisma.workOrder.update({
    where: { id: input.workOrderId },
    data: {
      ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
      ...(input.patch.description !== undefined ? { description: input.patch.description ?? null } : {}),
      ...(input.patch.priority !== undefined ? { priority: input.patch.priority } : {}),
      ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
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

  const order = await prisma.workOrder.findUnique({ where: { id: input.workOrderId } });
  if (!order) throw new NotFoundError("Work order was not found.");

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

  const existing = await prisma.workOrder.findUnique({ where: { id: input.workOrderId } });
  if (!existing) throw new NotFoundError("Work order was not found.");
  if (!existing.roomId) {
    throw new BadRequestError("Work order is not linked to a room.");
  }
  const room = await prisma.room.findUnique({ where: { id: existing.roomId } });
  if (!room) throw new NotFoundError("Room was not found.");

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

  const existing = await prisma.workOrder.findUnique({ where: { id: input.workOrderId } });
  if (!existing) throw new NotFoundError("Work order was not found.");
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
