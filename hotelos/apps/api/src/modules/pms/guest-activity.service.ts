// Guest activity aggregator — the Guest Journey's direct line to the chat,
// housekeeping and maintenance modules.
//
// For one reservation it returns a single, time-ordered feed of everything the
// guest has going on with any department: chat messages/complaints, housekeeping
// tasks for their room, maintenance work orders for their room, and service
// requests they raised. All from real tables — no synthetic activity.

import { prisma } from "@hotelos/database";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { NotFoundError } from "../../lib/http-error.js";

export type ActivityKind = "message" | "housekeeping" | "maintenance" | "service_request";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  department: string;
  title: string;
  detail?: string;
  status?: string;
  priority?: string;
  channel?: string;
  at: string;
  open: boolean;
  conversationId?: string;
};

export type GuestActivity = {
  reservationId: string;
  roomId?: string;
  guestId?: string;
  items: ActivityItem[];
  counts: {
    messages: number;
    housekeeping: number;
    maintenance: number;
    serviceRequests: number;
    openTotal: number;
    unreadGuest: number;
  };
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}
const HK_CLOSED = new Set(["done", "rejected"]);
const WO_CLOSED = new Set(["resolved", "closed"]);
const SR_CLOSED = new Set(["done", "cancelled"]);

export async function getGuestActivity(input: {
  context: UserContext;
  reservationId: string;
}): Promise<GuestActivity> {
  requirePermissions(input.context, ["pms.reservation.read"]);
  const res = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!res) throw new NotFoundError("Reservation not found.");

  const primaryLink = await prisma.reservationGuest.findFirst({
    where: { reservationId: res.id, isPrimary: true },
    select: { guestId: true }
  });
  const guestId = primaryLink?.guestId ?? undefined;
  const roomId = res.assignedRoomId ?? undefined;

  const items: ActivityItem[] = [];
  let unreadGuest = 0;

  // --- Chat: conversations linked to this reservation or guest ---
  const convWhere = guestId
    ? { propertyId: res.propertyId, OR: [{ reservationId: res.id }, { guestId }] }
    : { propertyId: res.propertyId, reservationId: res.id };
  const conversations = await prisma.conversation.findMany({ where: convWhere, orderBy: { createdAt: "desc" }, take: 50 });
  let messageCount = 0;
  for (const c of conversations) {
    const [last] = await prisma.message.findMany({ where: { conversationId: c.id }, orderBy: { sentAt: "desc" }, take: 1 });
    const total = await prisma.message.count({ where: { conversationId: c.id } });
    messageCount += total;
    const guestLast = Boolean(last && last.senderType === "guest");
    if (guestLast && c.status !== "closed") unreadGuest++;
    items.push({
      id: c.id,
      kind: "message",
      department: "Chat",
      title: `${cap(c.channel)} conversation${guestLast ? " · guest awaiting reply" : ""}`,
      detail: last ? `${last.senderType}: ${last.body.slice(0, 160)}` : "(no messages yet)",
      status: c.status,
      channel: c.channel,
      at: (last?.sentAt ?? c.createdAt).toISOString(),
      open: c.status !== "closed",
      conversationId: c.id
    });
  }

  // --- Housekeeping tasks for the assigned room ---
  let housekeepingCount = 0;
  if (roomId) {
    const tasks = await prisma.housekeepingTask.findMany({ where: { propertyId: res.propertyId, roomId }, orderBy: { createdAt: "desc" }, take: 50 });
    housekeepingCount = tasks.length;
    for (const t of tasks) {
      items.push({
        id: t.id,
        kind: "housekeeping",
        department: "Housekeeping",
        title: cap(t.taskType),
        status: t.status,
        priority: t.priority,
        at: t.createdAt.toISOString(),
        open: !HK_CLOSED.has(t.status)
      });
    }
  }

  // --- Maintenance work orders for the assigned room ---
  let maintenanceCount = 0;
  if (roomId) {
    const orders = await prisma.workOrder.findMany({ where: { propertyId: res.propertyId, roomId }, orderBy: { createdAt: "desc" }, take: 50 });
    maintenanceCount = orders.length;
    for (const w of orders) {
      items.push({
        id: w.id,
        kind: "maintenance",
        department: "Maintenance",
        title: w.title,
        detail: w.description ?? undefined,
        status: w.status,
        priority: w.priority,
        at: w.createdAt.toISOString(),
        open: !WO_CLOSED.has(w.status)
      });
    }
  }

  // --- Service requests (calls to a department) for this reservation/guest ---
  // Service requests currently persist in the demo-store; seeded ones may also
  // live in Prisma. Merge both, de-duped by id, so none are missed.
  const srWhere = guestId
    ? { propertyId: res.propertyId, OR: [{ reservationId: res.id }, { guestId }] }
    : { propertyId: res.propertyId, reservationId: res.id };
  const prismaReqs = await prisma.serviceRequest.findMany({ where: srWhere, orderBy: { createdAt: "desc" }, take: 50 });
  const merged = new Map<string, { id: string; requestType: string; status: string; assignedDepartment?: string | null; at: string }>();
  for (const s of prismaReqs) {
    merged.set(s.id, { id: s.id, requestType: s.requestType, status: s.status, assignedDepartment: s.assignedDepartment, at: s.createdAt.toISOString() });
  }
  for (const s of demoStore.serviceRequests) {
    if (s.propertyId !== res.propertyId) continue;
    if (s.reservationId !== res.id && !(guestId && s.guestId === guestId)) continue;
    merged.set(s.id, { id: s.id, requestType: s.requestType, status: s.status, assignedDepartment: s.assignedDepartment, at: s.createdAt });
  }
  const requests = Array.from(merged.values());
  for (const s of requests) {
    items.push({
      id: s.id,
      kind: "service_request",
      department: s.assignedDepartment ? cap(s.assignedDepartment) : "Reception",
      title: cap(s.requestType),
      status: s.status,
      at: s.at,
      open: !SR_CLOSED.has(s.status)
    });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  const openTotal = items.filter((i) => i.open).length;

  return {
    reservationId: res.id,
    roomId,
    guestId,
    items,
    counts: {
      messages: messageCount,
      housekeeping: housekeepingCount,
      maintenance: maintenanceCount,
      serviceRequests: requests.length,
      openTotal,
      unreadGuest
    }
  };
}
