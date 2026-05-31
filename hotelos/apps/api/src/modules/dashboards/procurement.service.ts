import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

// Read-only Procurement dashboard: PO + supplier overview for a property.
//
// Sharp edges to be aware of (see report):
//   * `PurchaseOrder` has no `number` column in Prisma — we expose `number`
//     as optional in the response (always undefined for now).
//   * Sprint 19 added `promisedDate` and `receivedDate` columns. OTD% is now
//     computed from the ratio of POs received on/before promisedDate over
//     POs with both dates populated. Suppliers with no dated POs surface 0.
//   * `Supplier.organizationId` (no `propertyId`). We therefore derive the
//     "active suppliers" set from the suppliers actually referenced by POs of
//     this property — this is the only way to scope supplier counts per
//     property without a schema change.
//   * `PurchaseOrder.total` is the source of truth for committed/received
//     value; we do not re-sum lines (would double-count when total is set).
//   * `from`/`to` default to the current calendar month and filter `createdAt`.

export type ProcurementDashboard = {
  kpis: {
    openPOs: number;
    pendingApproval: number;
    committedValueEur: number;
    receivedThisMonthEur: number;
    supplierCount: number;
  };
  posByStatus: Array<{ status: string; count: number; totalValueEur: number }>;
  topSuppliers: Array<{
    id: string;
    name: string;
    activePoCount: number;
    committedEur: number;
    otdRatePct: number;
  }>;
  recentPOs: Array<{
    id: string;
    number?: string;
    supplierName?: string;
    status: string;
    totalEur: number;
    createdAt: string;
  }>;
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Statuses we treat as "open" (i.e. work-in-flight, not closed/cancelled).
const CLOSED_STATUSES = new Set(["received", "closed", "cancelled", "rejected"]);
// Statuses we treat as "received" (delivered).
const RECEIVED_STATUSES = new Set(["received", "closed"]);
// Statuses we treat as "committed" (approved or ordered but not yet received).
const COMMITTED_STATUSES = new Set(["approved", "ordered", "sent", "partially_received"]);

export async function buildProcurementDashboard(input: {
  propertyId: string;
  from?: Date;
  to?: Date;
}): Promise<ProcurementDashboard> {
  const propertyId = input.propertyId;
  const now = new Date();
  const from = parseDate(input.from) ?? startOfMonth(now);
  const to = parseDate(input.to) ?? endOfMonth(now);

  // 1) Load purchase orders in window + suppliers in parallel.
  //    POs are filtered by createdAt within [from, to]; recentPOs uses the
  //    same window. We also load all POs of the property for status totals
  //    that should reflect "open right now" (openPOs/pendingApproval KPIs).
  const [poRowsInWindow, poRowsAll, supplierRows] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { propertyId, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.purchaseOrder.findMany({ where: { propertyId } }),
    prisma.supplier.findMany({ where: { active: true } })
  ]);

  const supplierById = new Map(supplierRows.map((s) => [s.id, s]));

  // 2) KPIs
  // openPOs = anything not in a closed terminal status (across all POs of the
  // property, not just the window — this is a "right now" snapshot).
  const openPOs = poRowsAll.filter((po) => !CLOSED_STATUSES.has(po.status)).length;
  const pendingApproval = poRowsAll.filter(
    (po) => po.status === "draft" || po.status === "pending_approval" || po.status === "submitted"
  ).length;

  // committedValueEur = sum of totals for POs currently committed (approved
  // or ordered, not yet received). Snapshot, not windowed.
  const committedValueEur = round(
    poRowsAll
      .filter((po) => COMMITTED_STATUSES.has(po.status))
      .reduce((sum, po) => sum + dec(po.total), 0)
  );

  // receivedThisMonthEur = sum of totals for POs whose receivedAt falls in
  // the current calendar month (independent of from/to window).
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);
  const receivedThisMonthEur = round(
    poRowsAll
      .filter((po) => {
        if (!RECEIVED_STATUSES.has(po.status)) return false;
        const ref = parseDate(po.receivedAt);
        return ref !== null && ref >= monthStart && ref <= monthEnd;
      })
      .reduce((sum, po) => sum + dec(po.total), 0)
  );

  // supplierCount = distinct active suppliers referenced by this property's POs.
  const referencedSupplierIds = new Set<string>();
  for (const po of poRowsAll) {
    if (po.supplierId) referencedSupplierIds.add(po.supplierId);
  }
  const supplierCount = Array.from(referencedSupplierIds).filter((id) => {
    const s = supplierById.get(id);
    return s ? s.active : false;
  }).length;

  // 3) posByStatus — counts + value bucketed by status (within window).
  type StatusAgg = { status: string; count: number; totalValueEur: number };
  const statusMap = new Map<string, StatusAgg>();
  for (const po of poRowsInWindow) {
    const existing = statusMap.get(po.status);
    if (existing) {
      existing.count += 1;
      existing.totalValueEur = round(existing.totalValueEur + dec(po.total));
    } else {
      statusMap.set(po.status, {
        status: po.status,
        count: 1,
        totalValueEur: round(dec(po.total))
      });
    }
  }
  const posByStatus = Array.from(statusMap.values()).sort((a, b) => b.count - a.count);

  // 4) topSuppliers — group all POs of this property by supplier, then take
  //    top 10 by committed value. OTD% = % of POs with both promisedDate and
  //    receivedDate where receivedDate <= promisedDate. Suppliers with no
  //    dated POs surface 0.
  type SupplierAgg = {
    id: string;
    name: string;
    activePoCount: number;
    committedEur: number;
    otdDeliveredCount: number;
    otdEligibleCount: number;
    otdRatePct: number;
  };
  const supplierAgg = new Map<string, SupplierAgg>();
  for (const po of poRowsAll) {
    if (!po.supplierId) continue;
    const supplier = supplierById.get(po.supplierId);
    const name = supplier?.name ?? "Unknown supplier";
    const key = po.supplierId;
    const isActive = !CLOSED_STATUSES.has(po.status);
    const isCommitted = COMMITTED_STATUSES.has(po.status);
    const promised = parseDate(po.promisedDate);
    const received = parseDate(po.receivedDate);
    const otdEligible = promised !== null && received !== null;
    const otdOnTime = otdEligible && received!.getTime() <= promised!.getTime();
    const existing = supplierAgg.get(key);
    if (existing) {
      if (isActive) existing.activePoCount += 1;
      if (isCommitted) existing.committedEur = round(existing.committedEur + dec(po.total));
      if (otdEligible) existing.otdEligibleCount += 1;
      if (otdOnTime) existing.otdDeliveredCount += 1;
    } else {
      supplierAgg.set(key, {
        id: key,
        name,
        activePoCount: isActive ? 1 : 0,
        committedEur: isCommitted ? round(dec(po.total)) : 0,
        otdDeliveredCount: otdOnTime ? 1 : 0,
        otdEligibleCount: otdEligible ? 1 : 0,
        otdRatePct: 0
      });
    }
  }
  for (const agg of supplierAgg.values()) {
    agg.otdRatePct =
      agg.otdEligibleCount === 0
        ? 0
        : Math.round((agg.otdDeliveredCount / agg.otdEligibleCount) * 1000) / 10;
  }
  const topSuppliers = Array.from(supplierAgg.values())
    .map((s) => ({
      id: s.id,
      name: s.name,
      activePoCount: s.activePoCount,
      committedEur: s.committedEur,
      otdRatePct: s.otdRatePct
    }))
    .sort((a, b) => b.committedEur - a.committedEur || b.activePoCount - a.activePoCount)
    .slice(0, 10);

  // 5) recentPOs — most recent 10 from the windowed list.
  const recentPOs = poRowsInWindow.slice(0, 10).map((po) => ({
    id: po.id,
    number: undefined, // No `number` column on PurchaseOrder.
    supplierName: po.supplierId ? supplierById.get(po.supplierId)?.name : undefined,
    status: po.status,
    totalEur: round(dec(po.total)),
    createdAt: po.createdAt.toISOString()
  }));

  return {
    kpis: {
      openPOs,
      pendingApproval,
      committedValueEur,
      receivedThisMonthEur,
      supplierCount
    },
    posByStatus,
    topSuppliers,
    recentPOs
  };
}
