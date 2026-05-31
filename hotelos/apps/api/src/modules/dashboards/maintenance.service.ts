import { prisma } from "@hotelos/database";

/**
 * Maintenance operations dashboard — read-only statistical view.
 *
 * Aggregates over WorkOrder / WorkOrderMedia / MaintenanceArea / MaintenanceAreaRoom /
 * MaintenanceRule for a single property, optionally within a date window (createdAt).
 *
 * Notes / sharp edges:
 *  - `overdueOrders` is now computed from WorkOrder.dueDate (Sprint 19 schema):
 *    orders whose dueDate is in the past and whose status is not resolved/closed.
 *  - WorkOrder still has no `category` column, so failure modes continue to be
 *    derived from active MaintenanceRule.ruleCode buckets.
 *  - `ordersByArea` joins WorkOrder.roomId -> MaintenanceAreaRoom.roomId ->
 *    MaintenanceArea.id.  Work orders without a room (or whose room is not mapped
 *    to any area) are excluded from per-area counts.
 *  - `backlogPct` = open / (open + resolved/closed) over the window, rounded to
 *    1 decimal.  Returns 0 when there are no orders in the window.
 *  - `avgResolutionHours` is computed across orders that have resolvedAt set
 *    within the window.  Returns 0 when none qualify.
 *  - All array fields default to [] and all numeric fields default to 0 when no
 *    rows are found.
 */

export type MaintenanceDashboard = {
  kpis: {
    openOrders: number;
    criticalOrders: number;
    overdueOrders: number;
    avgResolutionHours: number;
    backlogPct: number;
  };
  ordersByPriority: Array<{ priority: string; count: number }>;
  ordersByArea: Array<{ areaName: string; openCount: number; criticalCount: number }>;
  topFailureModes: Array<{ category: string; count: number }>;
  recentOrders: Array<{
    id: string;
    title: string;
    priority: string;
    status: string;
    areaName?: string;
    createdAt: string;
  }>;
};

const CRITICAL_PRIORITIES = new Set(["critical", "urgent", "high"]);
const CLOSED_STATUSES = new Set(["resolved", "closed"]);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function buildMaintenanceDashboard(input: {
  propertyId: string;
  from?: string;
  to?: string;
}): Promise<MaintenanceDashboard> {
  const empty: MaintenanceDashboard = {
    kpis: { openOrders: 0, criticalOrders: 0, overdueOrders: 0, avgResolutionHours: 0, backlogPct: 0 },
    ordersByPriority: [],
    ordersByArea: [],
    topFailureModes: [],
    recentOrders: []
  };

  if (!input.propertyId) return empty;

  const from = input.from ? new Date(input.from) : undefined;
  const to = input.to ? new Date(input.to) : undefined;

  const createdAtFilter =
    from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
      : {};

  const [orders, areas, areaRooms, rules] = await Promise.all([
    prisma.workOrder.findMany({
      where: { propertyId: input.propertyId, ...createdAtFilter },
      orderBy: { createdAt: "desc" }
    }),
    prisma.maintenanceArea.findMany({
      where: { propertyId: input.propertyId, active: true }
    }),
    prisma.maintenanceAreaRoom.findMany({}),
    prisma.maintenanceRule.findMany({
      where: { propertyId: input.propertyId, active: true }
    })
  ]);

  if (orders.length === 0 && areas.length === 0 && rules.length === 0) {
    return empty;
  }

  // Build room -> areaName map (constrained to areas in this property).
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const areaNameByRoom = new Map<string, string>();
  for (const link of areaRooms) {
    const area = areaById.get(link.maintenanceAreaId);
    if (area) areaNameByRoom.set(link.roomId, area.name);
  }

  // KPI accumulators.
  const now = new Date();
  let openOrders = 0;
  let criticalOrders = 0;
  let overdueOrders = 0;
  let resolvedCount = 0;
  let resolutionHoursTotal = 0;

  // Bucket accumulators.
  const byPriority = new Map<string, number>();
  const byArea = new Map<string, { openCount: number; criticalCount: number }>();

  for (const order of orders) {
    const priority = order.priority ?? "normal";
    const status = order.status as string;
    const isCritical = CRITICAL_PRIORITIES.has(priority);
    const isClosed = CLOSED_STATUSES.has(status);

    byPriority.set(priority, (byPriority.get(priority) ?? 0) + 1);

    if (!isClosed) openOrders += 1;
    if (isCritical && !isClosed) criticalOrders += 1;
    if (!isClosed && order.dueDate && order.dueDate.getTime() < now.getTime()) {
      overdueOrders += 1;
    }

    if (order.resolvedAt) {
      const ms = order.resolvedAt.getTime() - order.createdAt.getTime();
      if (Number.isFinite(ms) && ms >= 0) {
        resolvedCount += 1;
        resolutionHoursTotal += ms / 3_600_000;
      }
    }

    // Per-area roll-up: requires a roomId mapped to an area in this property.
    const areaName = order.roomId ? areaNameByRoom.get(order.roomId) : undefined;
    if (areaName) {
      const bucket = byArea.get(areaName) ?? { openCount: 0, criticalCount: 0 };
      if (!isClosed) bucket.openCount += 1;
      if (isCritical && !isClosed) bucket.criticalCount += 1;
      byArea.set(areaName, bucket);
    }
  }

  const totalForBacklog = orders.length;
  const backlogPct = totalForBacklog === 0 ? 0 : round1((openOrders / totalForBacklog) * 100);
  const avgResolutionHours = resolvedCount === 0 ? 0 : round1(resolutionHoursTotal / resolvedCount);

  const ordersByPriority = Array.from(byPriority.entries())
    .map(([priority, count]) => ({ priority, count }))
    .sort((a, b) => b.count - a.count);

  const ordersByArea = Array.from(byArea.entries())
    .map(([areaName, v]) => ({ areaName, openCount: v.openCount, criticalCount: v.criticalCount }))
    .sort((a, b) => b.openCount - a.openCount || b.criticalCount - a.criticalCount)
    .slice(0, 10);

  // Top failure modes derived from active MaintenanceRule.ruleCode (no category
  // column on WorkOrder).  Each rule contributes a count of 1 — the rule
  // catalogue itself is the failure-mode taxonomy in this codebase.
  const ruleCounts = new Map<string, number>();
  for (const rule of rules) {
    ruleCounts.set(rule.ruleCode, (ruleCounts.get(rule.ruleCode) ?? 0) + 1);
  }
  const topFailureModes = Array.from(ruleCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentOrders = orders.slice(0, 10).map((order) => ({
    id: order.id,
    title: order.title,
    priority: order.priority ?? "normal",
    status: order.status as string,
    areaName: order.roomId ? areaNameByRoom.get(order.roomId) : undefined,
    createdAt: order.createdAt.toISOString()
  }));

  return {
    kpis: { openOrders, criticalOrders, overdueOrders, avgResolutionHours, backlogPct },
    ordersByPriority,
    ordersByArea,
    topFailureModes,
    recentOrders
  };
}
