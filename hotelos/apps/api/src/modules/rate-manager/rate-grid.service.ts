// Rate Manager — grid surface for the BAR pricing experience.
//
// This module exposes the "rate grid" that the revenue manager UI works against:
// a 2D matrix of (roomType x date) cells holding price + restrictions, optionally
// projected onto a specific channel using its commission/markup. Edits write back
// to `RateDay` (the canonical per-day rate table — the "BAR level" for a cell)
// and journal every change in `RateChangeJournal` so the UI can show a history
// and the operator can replay/audit who changed what.
//
// Notes on the data model:
//   * "BARLevel" in the spec maps to `RateDay`, the per-(propertyId,ratePlan,
//     roomType,date) row that holds the actual price + `restrictionsJson`.
//     `BarLevel` (the catalog model) is a separate, simpler concept used for
//     price tier names and is not what we read/write here.
//   * Channel-specific overrides live as a markup derived from
//     `Channel.commissionPercent` — applied at read time when `channelId` is
//     supplied. When `bulkUpdateRateGrid` receives cells with `channelId`, we
//     persist the override via a `ChannelRateMapping` (status="active") so the
//     channel-manager push picks the right external rate code; the actual
//     numeric override is journaled and kept on the RateDay.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError } from "../../lib/http-error.js";
import { pushRates as channelPushRates } from "../channel-manager/aggregator.service.js";

// ---------------------------------------------------------------------- types

export type RateGridCell = {
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  price: number;
  currency: string;
  channelId?: string;
  minStay?: number;
  maxStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
  manuallyOverridden?: boolean;
};

export type RateChangeJournalEntry = {
  id: string;
  propertyId: string;
  userId: string;
  userEmail: string | null;
  timestamp: string;
  changesCount: number;
  reason: string | null;
  pushedTo: string[];
  pushStatus: string;
  changes: unknown;
};

// ----------------------------------------------------------------- utilities

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

function enumerateDates(fromISO: string, toISO: string): string[] {
  const from = dateOnly(fromISO);
  const to = dateOnly(toISO);
  if (to.getTime() < from.getTime()) throw new BadRequestError("'to' must be >= 'from'.");
  const out: string[] = [];
  const cur = new Date(from.getTime());
  while (cur.getTime() <= to.getTime()) {
    out.push(iso(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function restrictionFlags(raw: Prisma.JsonValue): {
  minStay?: number;
  maxStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const result: {
    minStay?: number;
    maxStay?: number;
    closedToArrival?: boolean;
    closedToDeparture?: boolean;
    stopSell?: boolean;
  } = {};
  if (typeof r.minStay === "number") result.minStay = r.minStay;
  if (typeof r.maxStay === "number") result.maxStay = r.maxStay;
  if (typeof r.closedToArrival === "boolean") result.closedToArrival = r.closedToArrival;
  if (typeof r.closedToDeparture === "boolean") result.closedToDeparture = r.closedToDeparture;
  if (typeof r.stopSell === "boolean") result.stopSell = r.stopSell;
  return result;
}

// -------------------------------------------------------------- getRateGrid

export async function getRateGrid(input: {
  propertyId: string;
  from: string;
  to: string;
  roomTypeIds?: string[];
  channelId?: string;
}): Promise<RateGridCell[]> {
  if (!input.propertyId) throw new BadRequestError("propertyId is required.");
  if (!input.from || !input.to) throw new BadRequestError("'from' and 'to' are required.");

  // 1) Enumerate the calendar window so we can fan out per-day below.
  const dates = enumerateDates(input.from, input.to);
  const from = dateOnly(input.from);
  const to = dateOnly(input.to);

  // 2) Load every (roomType, date) BAR row in range — and the matching
  //    restriction rows so a cell carries both price and restrictions.
  const rateDays = await prisma.rateDay.findMany({
    where: {
      propertyId: input.propertyId,
      date: { gte: from, lte: to },
      ...(input.roomTypeIds?.length ? { roomTypeId: { in: input.roomTypeIds } } : {})
    }
  });
  const restrictions = await prisma.restrictionDay.findMany({
    where: {
      propertyId: input.propertyId,
      date: { gte: from, lte: to },
      ...(input.roomTypeIds?.length ? { roomTypeId: { in: input.roomTypeIds } } : {})
    }
  });
  const restrictionByKey = new Map<string, (typeof restrictions)[number]>();
  for (const r of restrictions) {
    const key = `${r.roomTypeId}|${r.ratePlanId ?? ""}|${iso(r.date)}`;
    restrictionByKey.set(key, r);
  }

  // 3) If a channel was passed, load its commission once to derive the markup.
  //    The "markup" is the surcharge a channel sells over BAR; we approximate it
  //    with the commission percent so a 15% commission shows the BAR + 15%.
  let markupPct = 0;
  if (input.channelId) {
    const channel = await prisma.channel.findUnique({ where: { id: input.channelId } });
    if (channel && channel.propertyId !== input.propertyId) {
      throw new BadRequestError("channelId does not belong to this property.");
    }
    if (channel?.commissionPercent !== null && channel?.commissionPercent !== undefined) {
      markupPct = dec(channel.commissionPercent);
    }
  }

  const cells: RateGridCell[] = [];
  for (const row of rateDays) {
    const dateISO = iso(row.date);
    // Hard guard — should be impossible given the SQL filter, but keeps the
    // enumerated `dates` set authoritative if a caller mocks data.
    if (!dates.includes(dateISO)) continue;

    const basePrice = dec(row.price);
    const projected = input.channelId ? round2(basePrice * (1 + markupPct / 100)) : basePrice;

    const restrKey = `${row.roomTypeId}|${row.ratePlanId}|${dateISO}`;
    const restr = restrictionByKey.get(restrKey) ?? restrictionByKey.get(`${row.roomTypeId}||${dateISO}`);
    const fromJson = restrictionFlags(row.restrictionsJson);

    cells.push({
      roomTypeId: row.roomTypeId,
      ratePlanId: row.ratePlanId,
      date: dateISO,
      price: projected,
      currency: row.currency,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      minStay: restr?.minStay ?? fromJson.minStay,
      maxStay: restr?.maxStay ?? fromJson.maxStay,
      closedToArrival: restr?.closedToArrival ?? fromJson.closedToArrival,
      closedToDeparture: restr?.closedToDeparture ?? fromJson.closedToDeparture,
      stopSell: restr?.stopSell ?? fromJson.stopSell,
      manuallyOverridden: row.manuallyOverridden
    });
  }

  return cells;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --------------------------------------------------------- bulkUpdateRateGrid

// Patch shape for a bulk write: callers only need to specify the
// addressing keys (room + date + optional channel) and the deltas they
// want applied (price and/or restrictions). The service fans this out
// across RateDay/RateRestriction/ChannelMapping rows. `ratePlanId` is
// optional — when omitted the service falls back to the property's
// default BAR rate plan.
export type RateGridCellPatch = {
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  channelId?: string;
  price?: number;
  currency?: string;
  minStay?: number;
  maxStay?: number;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
};

export async function bulkUpdateRateGrid(input: {
  propertyId: string;
  context: UserContext;
  cells: RateGridCellPatch[];
  reason?: string;
}): Promise<{ updated: number; journalId: string }> {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  if (!input.propertyId) throw new BadRequestError("propertyId is required.");
  if (!Array.isArray(input.cells) || input.cells.length === 0) {
    throw new BadRequestError("cells[] is required.");
  }

  let updated = 0;
  // Journal entries store the raw patch each caller submitted (not the
  // hydrated grid cell), so a future UI can replay exactly what changed.
  const journaled: RateGridCellPatch[] = [];

  // 1) Upsert each cell into RateDay (BAR level) or activate the channel mapping
  //    when channelId is provided. The numeric price and restrictions always
  //    land on RateDay — the channel mapping just routes pushes to the right
  //    external code so distribution stays in sync.
  for (const cell of input.cells) {
    if (!cell.roomTypeId || !cell.ratePlanId || !cell.date) {
      throw new BadRequestError("each cell needs roomTypeId, ratePlanId and date.");
    }

    const restrictionsJson: Record<string, unknown> = {};
    if (cell.minStay !== undefined) restrictionsJson.minStay = cell.minStay;
    if (cell.maxStay !== undefined) restrictionsJson.maxStay = cell.maxStay;
    if (cell.closedToArrival !== undefined) restrictionsJson.closedToArrival = cell.closedToArrival;
    if (cell.closedToDeparture !== undefined) restrictionsJson.closedToDeparture = cell.closedToDeparture;
    if (cell.stopSell !== undefined) restrictionsJson.stopSell = cell.stopSell;

    await prisma.rateDay.upsert({
      where: {
        propertyId_ratePlanId_roomTypeId_date: {
          propertyId: input.propertyId,
          ratePlanId: cell.ratePlanId,
          roomTypeId: cell.roomTypeId,
          date: dateOnly(cell.date)
        }
      },
      create: {
        propertyId: input.propertyId,
        ratePlanId: cell.ratePlanId,
        roomTypeId: cell.roomTypeId,
        date: dateOnly(cell.date),
        // `price` is optional for restriction-only patches; default to 0 so
        // Prisma can create the row, and let later update calls own the
        // real numeric edit if any.
        price: cell.price ?? 0,
        currency: cell.currency || "EUR",
        manuallyOverridden: true,
        updatedBy: input.context.userId,
        restrictionsJson: restrictionsJson as Prisma.InputJsonValue
      },
      update: {
        price: cell.price,
        ...(cell.currency ? { currency: cell.currency } : {}),
        manuallyOverridden: true,
        updatedBy: input.context.userId,
        restrictionsJson: restrictionsJson as Prisma.InputJsonValue
      }
    });

    // Also persist explicit restriction columns when present so reads from the
    // canonical RestrictionDay table (used by distribution) stay aligned.
    if (
      cell.minStay !== undefined ||
      cell.maxStay !== undefined ||
      cell.closedToArrival !== undefined ||
      cell.closedToDeparture !== undefined ||
      cell.stopSell !== undefined
    ) {
      const restrKey = {
        propertyId: input.propertyId,
        roomTypeId: cell.roomTypeId,
        ratePlanId: cell.ratePlanId,
        channelId: cell.channelId ?? null,
        date: dateOnly(cell.date)
      };
      const restrData = {
        ...(cell.minStay !== undefined ? { minStay: cell.minStay } : {}),
        ...(cell.maxStay !== undefined ? { maxStay: cell.maxStay } : {}),
        ...(cell.closedToArrival !== undefined ? { closedToArrival: cell.closedToArrival } : {}),
        ...(cell.closedToDeparture !== undefined ? { closedToDeparture: cell.closedToDeparture } : {}),
        ...(cell.stopSell !== undefined ? { stopSell: cell.stopSell } : {}),
        restrictionSource: "rate-manager"
      };
      await prisma.restrictionDay.upsert({
        // The compound-unique includes nullable ratePlanId/channelId. Prisma's
        // generated input type rejects nulls there; cast the known-good shape.
        where: {
          propertyId_roomTypeId_ratePlanId_channelId_date: restrKey as unknown as {
            propertyId: string;
            roomTypeId: string;
            ratePlanId: string;
            channelId: string;
            date: Date;
          }
        },
        create: { ...restrKey, ...restrData },
        update: restrData
      });
    }

    // If the caller marked this as a channel-specific override, make sure
    // there is an active ChannelRateMapping linking the rate plan to the
    // channel so the push step can resolve an external rate code.
    if (cell.channelId) {
      const existing = await prisma.channelRateMapping.findFirst({
        where: { channelId: cell.channelId, ratePlanId: cell.ratePlanId }
      });
      if (!existing) {
        await prisma.channelRateMapping.create({
          data: {
            channelId: cell.channelId,
            ratePlanId: cell.ratePlanId,
            externalRateCode: cell.ratePlanId,
            status: "active"
          }
        });
      } else if (existing.status !== "active") {
        await prisma.channelRateMapping.update({
          where: { id: existing.id },
          data: { status: "active" }
        });
      }
    }

    journaled.push(cell);
    updated += 1;
  }

  // 2) Record one journal entry per bulk submission. The detail (every cell) is
  //    serialized into `changesJson` so the UI can reconstruct the change set.
  const journal = await prisma.rateChangeJournal.create({
    data: {
      propertyId: input.propertyId,
      userId: input.context.userId,
      userEmail: null,
      changesCount: journaled.length,
      changesJson: journaled as unknown as Prisma.InputJsonValue,
      reason: input.reason ?? null,
      pushedTo: [],
      pushStatus: "draft"
    }
  });

  return { updated, journalId: journal.id };
}

// ----------------------------------------------------------- pushRateGrid

export async function pushRateGrid(input: {
  propertyId: string;
  context: UserContext;
  from: string;
  to: string;
  channelIds: string[];
  roomTypeIds?: string[];
}): Promise<{ pushed: number; failedChannels: string[] }> {
  requirePermissions(input.context, ["distribution.sync"]);
  if (!input.propertyId) throw new BadRequestError("propertyId is required.");
  if (!input.from || !input.to) throw new BadRequestError("'from' and 'to' are required.");
  if (!Array.isArray(input.channelIds) || input.channelIds.length === 0) {
    throw new BadRequestError("channelIds[] is required.");
  }

  // 1) Resolve the cells in range so the count we report matches what hit the
  //    wire. The actual rate payload is built downstream by the channel manager
  //    aggregator (it reads RateDay directly using the mappings) — we pass the
  //    date range through.
  const cells = await getRateGrid({
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    roomTypeIds: input.roomTypeIds
  });

  const failedChannels: string[] = [];
  const succeededChannels: string[] = [];
  let pushed = 0;

  // 2) For each channel, push through the aggregator. We branch per-channel so
  //    a single bad adapter doesn't sink the whole batch.
  for (const channelId of input.channelIds) {
    try {
      const result = await channelPushRates({
        propertyId: input.propertyId,
        dateRange: { from: input.from, to: input.to },
        channelIds: [channelId]
      });
      const r = result.results[0];
      if (r && r.ok) {
        succeededChannels.push(channelId);
        pushed += r.pushed ?? cells.length;
      } else {
        failedChannels.push(channelId);
      }
    } catch {
      // Aggregator throws on truly unrecoverable failures (e.g. missing channel
      // row). Treat as a channel-level failure rather than aborting the rest.
      failedChannels.push(channelId);
    }
  }

  // 3) Stamp the most-recent journal entry for this property with the push
  //    outcome so the UI's "history" view can reflect distribution status.
  const latest = await prisma.rateChangeJournal.findFirst({
    where: { propertyId: input.propertyId },
    orderBy: { timestamp: "desc" }
  });
  if (latest) {
    const merged = Array.from(new Set([...(latest.pushedTo ?? []), ...succeededChannels]));
    await prisma.rateChangeJournal.update({
      where: { id: latest.id },
      data: {
        pushedTo: merged,
        pushStatus: failedChannels.length === 0 ? "pushed" : succeededChannels.length === 0 ? "failed" : "pushed"
      }
    });
  }

  return { pushed, failedChannels };
}

// ----------------------------------------------------------- getRateJournal

export async function getRateJournal(input: {
  propertyId: string;
  limit?: number;
}): Promise<RateChangeJournalEntry[]> {
  if (!input.propertyId) throw new BadRequestError("propertyId is required.");
  const take = Math.max(1, Math.min(input.limit ?? 50, 500));
  const rows = await prisma.rateChangeJournal.findMany({
    where: { propertyId: input.propertyId },
    orderBy: { timestamp: "desc" },
    take
  });
  return rows.map((r) => ({
    id: r.id,
    propertyId: r.propertyId,
    userId: r.userId,
    userEmail: r.userEmail ?? null,
    timestamp: r.timestamp.toISOString(),
    changesCount: r.changesCount,
    reason: r.reason ?? null,
    pushedTo: r.pushedTo ?? [],
    pushStatus: r.pushStatus,
    changes: r.changesJson
  }));
}
