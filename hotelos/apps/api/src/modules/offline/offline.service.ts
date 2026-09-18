// Sincronización offline de la app móvil (Tanda L2 · L2-04): cada acción
// reproducida deja una fila en `offline_sync_records` (OfflineSyncRecord, con
// organizationId desde L2-01) en lugar del array en memoria; la lista por
// propiedad filtra por propiedad Y por la organización de esa propiedad.
import type { OfflineAction, OfflineSyncRequest, OfflineSyncResponse, OfflineSyncResult } from "@hotelos/shared";
import { prisma, type Prisma } from "@hotelos/database";
import type { OfflineSyncRecord, UserContext } from "../../lib/demo-store.js";
import { NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { createHousekeepingTask, markRoomClean, updateHousekeepingTask } from "../housekeeping/housekeeping.service.js";
import { attachWorkOrderMedia, createWorkOrder } from "../maintenance/maintenance.service.js";

const allowedOfflineActionTypes = new Set([
  "housekeeping.room.clean",
  "housekeeping.task.create",
  "housekeeping.task.update",
  "housekeeping.note.create",
  "maintenance.work_order.draft",
  "maintenance.photo.pending_upload",
  "voice.command.draft",
  "confirmation.status.cache"
]);

const alwaysRejectedOfflineActionTypes = new Set(["invoice.issue", "reservation.check_in.final"]);

export function canAcceptOfflineAction(type: string): boolean {
  if (alwaysRejectedOfflineActionTypes.has(type)) {
    return false;
  }

  return allowedOfflineActionTypes.has(type);
}

export async function syncOfflineActions(input: {
  context: UserContext;
  request: OfflineSyncRequest;
  finalOfflineCheckInAllowed?: boolean;
}): Promise<OfflineSyncResponse> {
  // Fail-secure: la propiedad del lote debe pertenecer a la organización del
  // usuario (404 opaco; el ámbito RBAC por cabecera se comprueba antes).
  await requireOrganizationProperty(input.request.propertyId, input.context);
  // Sequential (not Promise.all) to preserve replay order — a create then an
  // update of the same entity must apply in order.
  const results: OfflineSyncResult[] = [];
  for (const action of input.request.actions) {
    results.push(
      await syncOneOfflineAction({
        context: input.context,
        propertyId: input.request.propertyId,
        deviceId: input.request.deviceId,
        action,
        finalOfflineCheckInAllowed: input.finalOfflineCheckInAllowed ?? false
      })
    );
  }

  return {
    accepted: results.filter((result) => result.status === "synced").length,
    rejected: results.filter((result) => result.status === "rejected").length,
    conflicts: results.filter((result) => result.status === "conflict").length,
    results
  };
}

async function syncOneOfflineAction(input: {
  context: UserContext;
  propertyId: string;
  deviceId: string;
  action: OfflineAction;
  finalOfflineCheckInAllowed: boolean;
}): Promise<OfflineSyncResult> {
  const rejection = validateOfflineAction(input.action, input.finalOfflineCheckInAllowed);
  if (rejection) {
    return persistSyncResult(input, {
      actionId: input.action.id,
      type: input.action.type,
      status: "rejected",
      reason: rejection
    });
  }

  try {
    const result = await executeOfflineAction(input);
    return persistSyncResult(input, result);
  } catch (error) {
    return persistSyncResult(input, {
      actionId: input.action.id,
      type: input.action.type,
      status: "conflict",
      reason: error instanceof Error ? error.message : "Offline action could not be applied."
    });
  }
}

function validateOfflineAction(action: OfflineAction, finalOfflineCheckInAllowed: boolean): string | undefined {
  if (action.type === "reservation.check_in.final" && !finalOfflineCheckInAllowed) {
    return "Offline final check-in is disabled for this property.";
  }

  if (action.type === "invoice.issue") {
    return "Offline invoice issuing is not allowed.";
  }

  if (!canAcceptOfflineAction(action.type)) {
    return `Offline action ${action.type} is not supported.`;
  }

  return undefined;
}

async function executeOfflineAction(input: {
  context: UserContext;
  propertyId: string;
  action: OfflineAction;
}): Promise<OfflineSyncResult> {
  const payload = input.action.payload as Record<string, unknown>;

  if (input.action.type === "housekeeping.room.clean") {
    const roomId = String(payload.roomId ?? "");
    const room = await markRoomClean({
      context: input.context,
      roomId,
      correlationId: createId("corr")
    });

    return synced(input.action, room.id);
  }

  if (input.action.type === "housekeeping.task.create") {
    const task = await createHousekeepingTask({
      context: input.context,
      propertyId: input.propertyId,
      roomId: String(payload.roomId ?? ""),
      taskType: (payload.taskType as Parameters<typeof createHousekeepingTask>[0]["taskType"]) ?? "stayover",
      priority: (payload.priority as Parameters<typeof createHousekeepingTask>[0]["priority"]) ?? "normal",
      assignedTo: typeof payload.assignedTo === "string" ? payload.assignedTo : undefined,
      dueAt: typeof payload.dueAt === "string" ? payload.dueAt : undefined,
      correlationId: createId("corr")
    });

    return synced(input.action, task.id);
  }

  if (input.action.type === "housekeeping.task.update") {
    const task = await updateHousekeepingTask({
      context: input.context,
      taskId: String(payload.taskId ?? ""),
      patch: {
        status: payload.status as Parameters<typeof updateHousekeepingTask>[0]["patch"]["status"],
        priority: payload.priority as Parameters<typeof updateHousekeepingTask>[0]["patch"]["priority"]
      },
      note: typeof payload.note === "string" ? payload.note : undefined,
      correlationId: createId("corr")
    });

    return synced(input.action, task.id);
  }

  if (input.action.type === "maintenance.work_order.draft") {
    const workOrder = await createWorkOrder({
      context: input.context,
      roomNumber: typeof payload.roomNumber === "string" ? payload.roomNumber : undefined,
      title: String(payload.title ?? "Offline maintenance draft"),
      description: typeof payload.description === "string" ? payload.description : undefined,
      priority: (payload.priority as Parameters<typeof createWorkOrder>[0]["priority"]) ?? "normal",
      blocksRoom: false,
      correlationId: createId("corr")
    });

    return synced(input.action, workOrder.id);
  }

  if (input.action.type === "maintenance.photo.pending_upload") {
    const media = await attachWorkOrderMedia({
      context: input.context,
      workOrderId: String(payload.workOrderId ?? ""),
      objectKey: String(payload.objectKey ?? ""),
      mediaType: (payload.mediaType as "photo" | "video") ?? "photo",
      correlationId: createId("corr")
    });

    return synced(input.action, media.id);
  }

  return synced(input.action);
}

function synced(action: OfflineAction, serverEntityId?: string): OfflineSyncResult {
  return {
    actionId: action.id,
    type: action.type,
    status: "synced",
    serverEntityId
  };
}

async function requireOrganizationProperty(propertyId: string, context: UserContext): Promise<{ organizationId: string }> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property || (property.organizationId !== context.organizationId && !context.isPlatformAdmin)) {
    throw new NotFoundError("Propiedad no encontrada.");
  }
  return property;
}

async function persistSyncResult(
  input: {
    context: UserContext;
    propertyId: string;
    deviceId: string;
    action: OfflineAction;
  },
  result: OfflineSyncResult
): Promise<OfflineSyncResult> {
  await prisma.offlineSyncRecord.create({
    data: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      deviceId: input.deviceId,
      actionJson: input.action as unknown as Prisma.InputJsonValue,
      resultJson: result as unknown as Prisma.InputJsonValue
    }
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: result.status === "synced" ? "OFFLINE_ACTION_SYNCED" : "OFFLINE_ACTION_REJECTED",
    entityType: "offline_action",
    entityId: input.action.id,
    afterJson: result,
    deviceId: input.deviceId
  });

  return result;
}

type OfflineSyncRow = NonNullable<Awaited<ReturnType<typeof prisma.offlineSyncRecord.findUnique>>>;

function toOfflineSyncRecord(row: OfflineSyncRow): OfflineSyncRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    deviceId: row.deviceId,
    action: row.actionJson as unknown as OfflineAction,
    result: row.resultJson as unknown as OfflineSyncResult,
    createdAt: row.createdAt.toISOString()
  };
}

const OFFLINE_SYNC_PAGE = 200;

/** Últimas 200 sincronizaciones de la propiedad, acotadas a la organización de esa propiedad. */
export async function listOfflineSyncRecords(propertyId: string): Promise<OfflineSyncRecord[]> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const rows = await prisma.offlineSyncRecord.findMany({
    where: { propertyId, organizationId: property.organizationId },
    orderBy: { createdAt: "desc" },
    take: OFFLINE_SYNC_PAGE
  });
  return rows.map(toOfflineSyncRecord);
}
