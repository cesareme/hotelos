// Rate grid — REAL persistence (P1.7).
//
// Reads/writes the canonical rate, restriction and inventory tables
// (RateDay / RestrictionDay / InventoryDay) instead of the in-memory
// advanced-records store. These are the SAME tables the channel-manager push
// and availability read from, so an edit here propagates to distribution.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError } from "../../lib/http-error.js";

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}
function dateOnly(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) throw new BadRequestError(`Invalid date: ${iso}`);
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getRateGrid(input: { propertyId: string; from?: string; to?: string }) {
  const from = input.from ? dateOnly(input.from) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const to = input.to ? dateOnly(input.to) : new Date(from.getTime() + 30 * 86_400_000);
  const range = { gte: from, lte: to };

  const [roomTypes, ratePlans, rates, restrictions, inventory] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId: input.propertyId, active: true }, select: { id: true, name: true, code: true } }),
    prisma.ratePlan.findMany({ where: { propertyId: input.propertyId }, select: { id: true, name: true, code: true } }),
    prisma.rateDay.findMany({ where: { propertyId: input.propertyId, date: range } }),
    prisma.restrictionDay.findMany({ where: { propertyId: input.propertyId, date: range } }),
    prisma.inventoryDay.findMany({ where: { propertyId: input.propertyId, date: range } })
  ]);

  return {
    from: iso(from),
    to: iso(to),
    roomTypes,
    ratePlans,
    rates: rates.map((r) => ({
      ratePlanId: r.ratePlanId,
      roomTypeId: r.roomTypeId,
      date: iso(r.date),
      price: dec(r.price),
      currency: r.currency,
      minPrice: r.minPrice === null ? undefined : dec(r.minPrice),
      maxPrice: r.maxPrice === null ? undefined : dec(r.maxPrice),
      manuallyOverridden: r.manuallyOverridden
    })),
    restrictions: restrictions.map((r) => ({
      roomTypeId: r.roomTypeId,
      ratePlanId: r.ratePlanId ?? undefined,
      date: iso(r.date),
      minStay: r.minStay ?? undefined,
      maxStay: r.maxStay ?? undefined,
      closedToArrival: r.closedToArrival,
      closedToDeparture: r.closedToDeparture,
      stopSell: r.stopSell
    })),
    inventory: inventory.map((r) => ({
      roomTypeId: r.roomTypeId,
      date: iso(r.date),
      totalInventory: r.totalInventory,
      availableCount: r.availableCount,
      stopSell: r.stopSell,
      overbookingLimit: r.overbookingLimit
    }))
  };
}

type RateUpdate = { ratePlanId: string; roomTypeId: string; date: string; price: number; currency?: string; minPrice?: number; maxPrice?: number };

export async function applyRateUpdates(input: { context: UserContext; propertyId: string; updates: RateUpdate[]; correlationId: string }) {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  if (!Array.isArray(input.updates) || input.updates.length === 0) throw new BadRequestError("updates[] is required.");
  let applied = 0;
  for (const u of input.updates) {
    if (!u.ratePlanId || !u.roomTypeId || !u.date || u.price === undefined) {
      throw new BadRequestError("each rate update needs ratePlanId, roomTypeId, date and price.");
    }
    await prisma.rateDay.upsert({
      where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: input.propertyId, ratePlanId: u.ratePlanId, roomTypeId: u.roomTypeId, date: dateOnly(u.date) } },
      create: {
        propertyId: input.propertyId,
        ratePlanId: u.ratePlanId,
        roomTypeId: u.roomTypeId,
        date: dateOnly(u.date),
        price: u.price,
        currency: u.currency ?? "EUR",
        minPrice: u.minPrice ?? null,
        maxPrice: u.maxPrice ?? null,
        manuallyOverridden: true,
        updatedBy: input.context.userId
      },
      update: {
        price: u.price,
        ...(u.currency ? { currency: u.currency } : {}),
        ...(u.minPrice !== undefined ? { minPrice: u.minPrice } : {}),
        ...(u.maxPrice !== undefined ? { maxPrice: u.maxPrice } : {}),
        manuallyOverridden: true,
        updatedBy: input.context.userId
      }
    });
    applied += 1;
  }
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "RATE_DAYS_UPDATED",
    entityType: "rate_day",
    entityId: input.propertyId,
    afterJson: { applied },
    correlationId: input.correlationId
  });
  return { applied };
}

type RestrictionUpdate = {
  roomTypeId: string;
  ratePlanId?: string;
  date: string;
  minStay?: number;
  maxStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
};

export async function applyRestrictionUpdates(input: { context: UserContext; propertyId: string; updates: RestrictionUpdate[]; correlationId: string }) {
  requirePermissions(input.context, ["revenue.manage_restrictions"]);
  if (!Array.isArray(input.updates) || input.updates.length === 0) throw new BadRequestError("updates[] is required.");
  let applied = 0;
  for (const u of input.updates) {
    if (!u.roomTypeId || !u.date) throw new BadRequestError("each restriction update needs roomTypeId and date.");
    const key = {
      propertyId: input.propertyId,
      roomTypeId: u.roomTypeId,
      ratePlanId: u.ratePlanId ?? null,
      channelId: null,
      date: dateOnly(u.date)
    };
    const data = {
      ...(u.minStay !== undefined ? { minStay: u.minStay } : {}),
      ...(u.maxStay !== undefined ? { maxStay: u.maxStay } : {}),
      ...(u.closedToArrival !== undefined ? { closedToArrival: u.closedToArrival } : {}),
      ...(u.closedToDeparture !== undefined ? { closedToDeparture: u.closedToDeparture } : {}),
      ...(u.stopSell !== undefined ? { stopSell: u.stopSell } : {}),
      restrictionSource: "manual"
    };
    await prisma.restrictionDay.upsert({
      // Prisma's compound-unique type rejects null on optional id columns even
      // though they're valid at runtime. Cast through unknown for this known
      // pattern (Restriction key with null ratePlanId/channelId is intentional).
      where: { propertyId_roomTypeId_ratePlanId_channelId_date: key as unknown as { propertyId: string; roomTypeId: string; ratePlanId: string; channelId: string; date: Date } },
      create: { ...key, ...data },
      update: data
    });
    applied += 1;
  }
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "RESTRICTION_DAYS_UPDATED",
    entityType: "restriction_day",
    entityId: input.propertyId,
    afterJson: { applied },
    correlationId: input.correlationId
  });
  return { applied };
}

type InventoryUpdate = { roomTypeId: string; date: string; totalInventory?: number; availableCount?: number; stopSell?: boolean; overbookingLimit?: number; outOfOrderCount?: number };

export async function applyInventoryUpdates(input: { context: UserContext; propertyId: string; updates: InventoryUpdate[]; correlationId: string }) {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  if (!Array.isArray(input.updates) || input.updates.length === 0) throw new BadRequestError("updates[] is required.");
  let applied = 0;
  for (const u of input.updates) {
    if (!u.roomTypeId || !u.date) throw new BadRequestError("each inventory update needs roomTypeId and date.");
    const key = { propertyId_roomTypeId_date: { propertyId: input.propertyId, roomTypeId: u.roomTypeId, date: dateOnly(u.date) } };
    await prisma.inventoryDay.upsert({
      where: key,
      create: {
        propertyId: input.propertyId,
        roomTypeId: u.roomTypeId,
        date: dateOnly(u.date),
        totalInventory: u.totalInventory ?? 0,
        availableCount: u.availableCount ?? u.totalInventory ?? 0,
        stopSell: u.stopSell ?? false,
        overbookingLimit: u.overbookingLimit ?? 0,
        outOfOrderCount: u.outOfOrderCount ?? 0
      },
      update: {
        ...(u.totalInventory !== undefined ? { totalInventory: u.totalInventory } : {}),
        ...(u.availableCount !== undefined ? { availableCount: u.availableCount } : {}),
        ...(u.stopSell !== undefined ? { stopSell: u.stopSell } : {}),
        ...(u.overbookingLimit !== undefined ? { overbookingLimit: u.overbookingLimit } : {}),
        ...(u.outOfOrderCount !== undefined ? { outOfOrderCount: u.outOfOrderCount } : {})
      }
    });
    applied += 1;
  }
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVENTORY_DAYS_UPDATED",
    entityType: "inventory_day",
    entityId: input.propertyId,
    afterJson: { applied },
    correlationId: input.correlationId
  });
  return { applied };
}
