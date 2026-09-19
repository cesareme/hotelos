// Herramientas de housekeeping y mantenimiento (Tanda L6a, lote 3): una
// lectura (tablero) y siete escrituras que el runner deja SIEMPRE en
// awaiting_confirmation. Los servicios aplican sus propios permisos y tenencia.

import { z } from "zod";
import { createHousekeepingTask, getHousekeepingBoard, markRoomClean, markRoomInspected } from "../../housekeeping/housekeeping.service.js";
import { blockRoomForMaintenance, createWorkOrder, resolveWorkOrder } from "../../maintenance/maintenance.service.js";
import { defineAiTool } from "./context.js";

const HK_TASK_TYPES = ["departure_clean", "stayover", "inspection", "deep_clean"] as const;
const HK_TASK_PRIORITIES = ["low", "normal", "high"] as const;
const WO_PRIORITIES = ["emergency", "urgent", "normal", "preventive"] as const;

type RoomRecord = Awaited<ReturnType<typeof markRoomClean>>;
type WorkOrderRecord = Awaited<ReturnType<typeof createWorkOrder>>;

function roomSummary(room: RoomRecord): { roomId: string; number: string; status: string; housekeepingStatus: string } {
  return { roomId: room.id, number: room.number, status: String(room.status), housekeepingStatus: String(room.housekeepingStatus) };
}

function workOrderSummary(order: WorkOrderRecord): { workOrderId: string; status: string; priority: string; blocksRoom: boolean; roomId: string | null } {
  return { workOrderId: order.id, status: order.status, priority: order.priority, blocksRoom: order.blocksRoom, roomId: order.roomId ?? null };
}

export const getHousekeepingBoardTool = defineAiTool({
  name: "getHousekeepingBoard",
  effect: "read",
  description: "Devuelve el tablero de pisos de la propiedad: habitaciones con estado de limpieza y tareas abiertas.",
  inputSchema: z.object({}).strict(),
  outputSchema: z.array(z.custom<Awaited<ReturnType<typeof getHousekeepingBoard>>[number]>()),
  modelInputSchema: { type: "object", additionalProperties: false, properties: {} },
  async execute(_input, ctx) {
    const board = await getHousekeepingBoard(ctx.propertyId);
    return { output: board, record: { rooms: board.length } };
  }
});

export const createHousekeepingTaskTool = defineAiTool({
  name: "createHousekeepingTask",
  effect: "write",
  description: "Crea una tarea de limpieza para una habitación.",
  inputSchema: z
    .object({ roomId: z.string().trim().min(1), taskType: z.enum(HK_TASK_TYPES), priority: z.enum(HK_TASK_PRIORITIES).optional(), assignedTo: z.string().trim().min(1).optional(), dueAt: z.string().trim().min(1).optional() })
    .strict(),
  outputSchema: z.custom<Awaited<ReturnType<typeof createHousekeepingTask>>>(),
  modelInputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["roomId", "taskType"],
    properties: { roomId: { type: "string" }, taskType: { type: "string", enum: [...HK_TASK_TYPES] }, priority: { type: "string", enum: [...HK_TASK_PRIORITIES] }, assignedTo: { type: "string" }, dueAt: { type: "string" } }
  },
  preview(input) {
    return { action: "createHousekeepingTask", ...input };
  },
  async execute(input, ctx) {
    const task = await createHousekeepingTask({ context: ctx.user, propertyId: ctx.propertyId, ...input, correlationId: ctx.correlationId });
    return { output: task, record: { taskId: task.id, roomId: task.roomId, taskType: task.taskType, status: task.status } };
  }
});

export const markRoomCleanTool = defineAiTool({
  name: "markRoomClean",
  effect: "write",
  description: "Marca una habitación como limpia.",
  inputSchema: z.object({ roomId: z.string().trim().min(1) }).strict(),
  outputSchema: z.custom<RoomRecord>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["roomId"], properties: { roomId: { type: "string" } } },
  preview(input) {
    return { action: "markRoomClean", roomId: input.roomId };
  },
  async execute(input, ctx) {
    const room = await markRoomClean({ context: ctx.user, roomId: input.roomId, correlationId: ctx.correlationId });
    return { output: room, record: roomSummary(room) };
  }
});

export const markRoomInspectedTool = defineAiTool({
  name: "markRoomInspected",
  effect: "write",
  description: "Marca una habitación limpia como inspeccionada.",
  inputSchema: z.object({ roomId: z.string().trim().min(1) }).strict(),
  outputSchema: z.custom<RoomRecord>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["roomId"], properties: { roomId: { type: "string" } } },
  preview(input) {
    return { action: "markRoomInspected", roomId: input.roomId };
  },
  async execute(input, ctx) {
    const room = await markRoomInspected({ context: ctx.user, roomId: input.roomId, correlationId: ctx.correlationId });
    return { output: room, record: roomSummary(room) };
  }
});

export const createWorkOrderTool = defineAiTool({
  name: "createWorkOrder",
  effect: "write",
  description: "Abre un parte de mantenimiento (opcionalmente ligado a una habitación y bloqueándola).",
  inputSchema: z
    .object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).optional(), roomNumber: z.string().trim().min(1).max(20).optional(), priority: z.enum(WO_PRIORITIES), blocksRoom: z.boolean() })
    .strict(),
  outputSchema: z.custom<WorkOrderRecord>(),
  modelInputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "priority", "blocksRoom"],
    properties: { title: { type: "string" }, description: { type: "string" }, roomNumber: { type: "string" }, priority: { type: "string", enum: [...WO_PRIORITIES] }, blocksRoom: { type: "boolean" } }
  },
  preview(input) {
    return { action: "createWorkOrder", ...input };
  },
  async execute(input, ctx) {
    const order = await createWorkOrder({ context: ctx.user, ...input, correlationId: ctx.correlationId });
    return { output: order, record: workOrderSummary(order) };
  }
});

export const blockRoomForMaintenanceTool = defineAiTool({
  name: "blockRoomForMaintenance",
  effect: "write",
  description: "Bloquea la habitación de un parte de mantenimiento (deja de venderse).",
  inputSchema: z.object({ workOrderId: z.string().trim().min(1) }).strict(),
  outputSchema: z.custom<WorkOrderRecord>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["workOrderId"], properties: { workOrderId: { type: "string" } } },
  preview(input) {
    return { action: "blockRoomForMaintenance", workOrderId: input.workOrderId };
  },
  async execute(input, ctx) {
    const order = await blockRoomForMaintenance({ context: ctx.user, workOrderId: input.workOrderId, correlationId: ctx.correlationId });
    return { output: order, record: workOrderSummary(order) };
  }
});

export const resolveWorkOrderTool = defineAiTool({
  name: "resolveWorkOrder",
  effect: "write",
  description: "Resuelve un parte de mantenimiento y, opcionalmente, libera la habitación.",
  inputSchema: z.object({ workOrderId: z.string().trim().min(1), resolutionNote: z.string().trim().max(2000).optional(), releaseRoom: z.boolean().optional() }).strict(),
  outputSchema: z.custom<WorkOrderRecord>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["workOrderId"], properties: { workOrderId: { type: "string" }, resolutionNote: { type: "string" }, releaseRoom: { type: "boolean" } } },
  preview(input) {
    return { action: "resolveWorkOrder", ...input };
  },
  async execute(input, ctx) {
    const order = await resolveWorkOrder({ context: ctx.user, ...input, correlationId: ctx.correlationId });
    return { output: order, record: workOrderSummary(order) };
  }
});
