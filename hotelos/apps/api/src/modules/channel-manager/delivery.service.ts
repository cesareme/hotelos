// Channel outbox (rate grid v2 · lote api-channel-outbox).
//
// `enqueueRateGridPush` is what the editor's "Publicar" calls (through the
// rate-manager module): it loads the rates / restrictions / availability of the
// range, translates each mapped product to the channel's external codes and
// writes ONE ChannelDelivery per (channel, kind, roomType, plan | "*", date).
// Nothing is sent here — drain.service picks the queue up (every
// CHANNEL_DRAIN_INTERVAL_MS on the scheduler leader, or on demand through
// POST /channel-manager/deliveries/drain).
//
// The push is SCOPED: `roomTypeIds` / `ratePlanIds` / `kinds` narrow the
// plan to the products and kinds the caller touched (the rate-grid derives
// them from the patches of a bulk-update), so publishing one cell queues one
// delivery per channel instead of the whole window × every room type.
//
// `getCellSyncMap` is the read side the grid paints: Map<`${ratePlanId}|${roomTypeId}|${date}`,
// Record<channelId, CellSyncState>>. Its signature is a contract with the
// api-rate-grid lote (imported from "../channel-manager/delivery.service.js").
// A delivered row whose VALUE no longer matches the grid (revert, edit saved
// without publishing) is reported as `stale`: the same planner that builds a
// push computes the current payload of every delivered cell and the value
// hashes are compared (mapping codes excluded — a remap is not a stale rate).
//
// journal.pushStatus lifecycle: `queued` when the enqueue queued or re-queued
// something (left untouched when everything was skipped: nothing was sent, the
// entry keeps `draft`); recomputed from its deliveries after every drain and
// after a later publish supersedes its rows (`refreshJournalPushStatuses`):
// queued (still pending) · pushed (all confirmed) · partial · failed ·
// superseded (every row replaced by a newer publish).
//
// Availability source: InventoryDay.availableCount when the row exists;
// otherwise the real availability = sellable rooms − rooms of overlapping
// confirmed/checked-in reservations, replicating the per-night rule of
// pms.service.quoteAvailability (that function quotes a whole stay and runs
// three queries per room type, so it is replicated here per day rather than
// imported).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { CellSyncState, RateGridPushResponse, RateGridSyncStatusResponse } from "@hotelos/shared";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { DeliveryKind } from "./adapter.types.js";
import { effectiveChannelMode, listRateGridChannels, type ChannelRow } from "./channels.service.js";
import {
  DELIVERED_STATUSES,
  DELIVERY_KINDS,
  REQUEUE_FROM_STATUSES,
  SUPERSEDABLE_STATUSES,
  assertKnownChannelIds,
  buildCellSyncMap,
  classifyJournalPushStatus,
  currentValueHashes,
  filterByIds,
  latestByDeliveryCell,
  listDates,
  planDeliveries,
  valueHash,
  type DeliveryStatus,
  type ExistingDelivery,
  type PlanChannel,
  type PlanInput,
  type PlanRestriction,
  type SyncMapRow
} from "./delivery.core.js";
import { isDistributableRatePlan, loadProductMappingIndex } from "./mapping.service.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function requireIsoDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new BadRequestError(`${name} debe tener formato YYYY-MM-DD.`);
  }
  return value;
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function requireRange(from: unknown, to: unknown): { from: string; to: string; dates: string[] } {
  const f = requireIsoDate(from, "from");
  const t = requireIsoDate(to, "to");
  if (f > t) throw new BadRequestError("from debe ser anterior o igual a to.");
  const dates = listDates(f, t);
  if (dates.length > MAX_RANGE_DAYS) throw new BadRequestError(`El rango no puede superar ${MAX_RANGE_DAYS} días.`);
  return { from: f, to: t, dates };
}

function parseKinds(kinds: unknown): DeliveryKind[] {
  if (!Array.isArray(kinds) || kinds.length === 0) return [...DELIVERY_KINDS];
  const out = kinds.filter((k): k is DeliveryKind => (DELIVERY_KINDS as readonly string[]).includes(String(k)));
  if (out.length === 0) throw new BadRequestError(`kinds debe contener alguno de: ${DELIVERY_KINDS.join(", ")}.`);
  return out;
}

// ---------------------------------------------------------------- availability

/** Per-day real availability of the room types: sellable rooms − overlapping reservations. */
export async function computeRealAvailability(propertyId: string, roomTypeIds: string[], dates: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (roomTypeIds.length === 0 || dates.length === 0) return out;
  const from = dateOnly(dates[0] as string);
  const toExclusive = new Date(dateOnly(dates[dates.length - 1] as string).getTime() + 86_400_000);
  const [rooms, reservations] = await Promise.all([
    prisma.room.groupBy({
      by: ["roomTypeId"],
      where: {
        propertyId,
        roomTypeId: { in: roomTypeIds },
        sellable: true,
        active: true,
        OR: [{ maintenanceStatus: null }, { maintenanceStatus: { not: "blocked" } }]
      },
      _count: { _all: true }
    }),
    prisma.reservation.findMany({
      where: {
        propertyId,
        roomTypeId: { in: roomTypeIds },
        status: { in: ["confirmed", "checked_in"] },
        deletedAt: null,
        arrivalDate: { lt: toExclusive },
        departureDate: { gt: from }
      },
      select: { roomTypeId: true, arrivalDate: true, departureDate: true, roomsCount: true }
    })
  ]);
  const total = new Map(rooms.map((r) => [r.roomTypeId, r._count._all] as const));
  const booked = new Map<string, number>();
  for (const r of reservations) {
    if (!r.roomTypeId) continue;
    for (let t = r.arrivalDate.getTime(); t < r.departureDate.getTime(); t += 86_400_000) {
      const k = `${r.roomTypeId}|${iso(new Date(t))}`;
      booked.set(k, (booked.get(k) ?? 0) + r.roomsCount);
    }
  }
  for (const rt of roomTypeIds) {
    for (const d of dates) {
      const k = `${rt}|${d}`;
      out.set(k, Math.max(0, (total.get(rt) ?? 0) - (booked.get(k) ?? 0)));
    }
  }
  return out;
}

// ---------------------------------------------------------------- enqueue

export type EnqueueRateGridPushInput = {
  propertyId: string;
  from: string;
  to: string;
  channelIds: string[];
  ratePlanIds?: string[];
  roomTypeIds?: string[];
  kinds?: Array<"rates" | "availability" | "restrictions">;
  journalId?: string | null;
  actorUserId: string;
};

export async function enqueueRateGridPush(input: EnqueueRateGridPushInput): Promise<RateGridPushResponse> {
  const { from, to, dates } = requireRange(input.from, input.to);
  const kinds = parseKinds(input.kinds);
  if (!Array.isArray(input.channelIds) || input.channelIds.length === 0) throw new BadRequestError("channelIds es obligatorio.");

  // Tenancy of the journal id: the route only checks body.propertyId, so a
  // journal of another property must be refused here BEFORE anything is
  // written (otherwise its status/pushedTo would be stamped cross-tenant).
  if (input.journalId) {
    const journal = await prisma.rateChangeJournal.findFirst({ where: { id: input.journalId, propertyId: input.propertyId }, select: { id: true } });
    if (!journal) throw new NotFoundError("Entrada del historial de tarifas no encontrada.");
  }

  const channels = await prisma.channel.findMany({ where: { propertyId: input.propertyId, id: { in: input.channelIds } } });
  const missing = input.channelIds.filter((id) => !channels.some((c) => c.id === id));
  if (missing.length > 0) throw new NotFoundError("Canal no encontrado.");

  const fromDate = dateOnly(from);
  const toDate = dateOnly(to);
  const [current, existingRows] = await Promise.all([
    loadPlanInput({ propertyId: input.propertyId, channels, dates, kinds, roomTypeIds: input.roomTypeIds, ratePlanIds: input.ratePlanIds }),
    prisma.channelDelivery.findMany({
      where: { channelId: { in: channels.map((c) => c.id) }, kind: { in: kinds }, date: { gte: fromDate, lte: toDate } },
      select: { id: true, channelId: true, kind: true, roomTypeId: true, ratePlanId: true, date: true, status: true, idempotencyKey: true, payloadHash: true, updatedAt: true, journalId: true }
    })
  ]);

  const plan = planDeliveries({
    ...current,
    existing: existingRows.map(
      (e): ExistingDelivery => ({
        id: e.id,
        channelId: e.channelId,
        kind: e.kind as DeliveryKind,
        roomTypeId: e.roomTypeId,
        ratePlanId: e.ratePlanId,
        date: iso(e.date),
        status: e.status as DeliveryStatus,
        idempotencyKey: e.idempotencyKey,
        payloadHash: e.payloadHash,
        updatedAt: e.updatedAt.toISOString()
      })
    )
  });

  const warnings = [...plan.warnings];
  const anythingQueued = plan.drafts.length + plan.requeue.length > 0;
  await prisma.$transaction(async (tx) => {
    // The plan was computed from rows read outside this transaction; the
    // scheduler leader may have CLAIMED one of them in between (`sending`).
    // Both updates are therefore guarded by the status the plan assumed:
    // a row in flight is neither superseded (its outcome must land) nor put
    // back to queued (a second drain would send it again). What could not be
    // touched is reported, never silently counted as queued.
    if (plan.supersede.length > 0) {
      const res = await tx.channelDelivery.updateMany({
        where: { id: { in: plan.supersede }, status: { in: [...SUPERSEDABLE_STATUSES] } },
        data: { status: "superseded", nextRetryAt: null }
      });
      if (res.count < plan.supersede.length) {
        warnings.push(`${plan.supersede.length - res.count} entrega(s) ya en envío no se han podido sustituir: el valor nuevo se enviará después.`);
      }
    }
    if (plan.requeue.length > 0) {
      // `createdAt` is the PLAN order of the outbox (the drain sends oldest
      // first and retires a row when a later one exists for the same cell):
      // a re-queued row is planned again NOW, so it moves to the head of its
      // cell instead of keeping the timestamp of its first enqueue.
      const res = await tx.channelDelivery.updateMany({
        where: { id: { in: plan.requeue }, status: { in: [...REQUEUE_FROM_STATUSES] } },
        data: { status: "queued", attempts: 0, nextRetryAt: null, lastError: null, sentAt: null, confirmedAt: null, createdAt: new Date(), ...(input.journalId ? { journalId: input.journalId } : {}) }
      });
      if (res.count < plan.requeue.length) {
        warnings.push(`${plan.requeue.length - res.count} entrega(s) ya en cola o en envío no se han reencolado.`);
      }
    }
    if (plan.drafts.length > 0) {
      await tx.channelDelivery.createMany({
        data: plan.drafts.map((d) => ({
          propertyId: input.propertyId,
          channelId: d.channelId,
          kind: d.kind,
          roomTypeId: d.roomTypeId,
          ratePlanId: d.ratePlanId,
          date: dateOnly(d.date),
          payloadJson: d.payload as Prisma.InputJsonValue,
          payloadHash: d.payloadHash,
          idempotencyKey: d.idempotencyKey,
          status: "queued",
          journalId: input.journalId ?? null
        })),
        skipDuplicates: true
      });
    }
    if (input.journalId && anythingQueued) {
      // Scoped to the property again inside the transaction (validated above).
      // `queued` is honest: nothing has been sent yet; the drain recomputes the
      // status from the outcomes. When nothing was queued (every value already
      // on the channel, or skipped) the entry is left as it is: stamping
      // `published`/`pushed` would claim a send that never happened.
      const journal = await tx.rateChangeJournal.findFirst({ where: { id: input.journalId, propertyId: input.propertyId }, select: { pushedTo: true } });
      if (journal) {
        await tx.rateChangeJournal.updateMany({
          where: { id: input.journalId, propertyId: input.propertyId },
          data: { pushedTo: [...new Set([...journal.pushedTo, ...channels.map((c) => c.id)])], pushStatus: "queued", status: "published" }
        });
      }
    }
  });

  // The rows this publish superseded belonged to earlier entries: their
  // pushStatus may have become `superseded` (or `partial`) — recompute it.
  const supersededIds = new Set(plan.supersede);
  const touchedJournals = new Set<string>();
  for (const row of existingRows) if (supersededIds.has(row.id) && row.journalId && row.journalId !== input.journalId) touchedJournals.add(row.journalId);
  if (touchedJournals.size > 0) await refreshJournalPushStatuses([...touchedJournals]);

  const queued = Object.values(plan.byChannel).reduce((acc, c) => acc + c.queued, 0);
  return { queued, byChannel: plan.byChannel, warnings: [...new Set(warnings)] };
}

/**
 * Recomputes `RateChangeJournal.pushStatus` from the deliveries of each entry
 * (`classifyJournalPushStatus`). Called after a drain wrote outcomes and after
 * a publish superseded rows of earlier entries; an entry with no deliveries
 * keeps its stored value.
 */
export async function refreshJournalPushStatuses(journalIds: string[]): Promise<void> {
  for (const journalId of new Set(journalIds)) {
    const groups = await prisma.channelDelivery.groupBy({ by: ["status"], where: { journalId }, _count: { _all: true } });
    const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Partial<Record<DeliveryStatus, number>>;
    const pushStatus = classifyJournalPushStatus(counts);
    if (!pushStatus) continue;
    await prisma.rateChangeJournal.updateMany({ where: { id: journalId, pushStatus: { not: pushStatus } }, data: { pushStatus } });
  }
}

// ---------------------------------------------------------------- plan input (shared by enqueue and the sync map)

type PlanWindowInput = {
  propertyId: string;
  channels: ChannelRow[];
  dates: string[];
  kinds: DeliveryKind[];
  roomTypeIds?: string[] | undefined;
  ratePlanIds?: string[] | undefined;
};

/**
 * Everything the planner needs for a window EXCEPT the existing deliveries:
 * channels with their mappings, the products in scope (active room types ×
 * distributable plans, narrowed by the optional id filters), rates,
 * restrictions and availability. The enqueue adds the existing rows; the sync
 * map runs it with none to learn the CURRENT value of every cell.
 */
async function loadPlanInput(input: PlanWindowInput): Promise<Omit<PlanInput, "existing">> {
  const { propertyId, channels, dates, kinds } = input;
  const fromDate = dateOnly(dates[0] as string);
  const toDate = dateOnly(dates[dates.length - 1] as string);
  const [roomTypesAll, ratePlansAll, mappingIndex, property] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId, active: true }, select: { id: true, code: true } }),
    prisma.ratePlan.findMany({ where: { propertyId, active: true }, select: { id: true, code: true, active: true, ratePlanType: true } }),
    loadProductMappingIndex(channels.map((c) => c.id)),
    prisma.property.findUnique({ where: { id: propertyId }, select: { currency: true } })
  ]);
  const roomTypes = filterByIds(roomTypesAll, input.roomTypeIds);
  const ratePlans = filterByIds(ratePlansAll.filter(isDistributableRatePlan), input.ratePlanIds);
  const roomTypeIds = roomTypes.map((r) => r.id);
  const ratePlanIds = ratePlans.map((r) => r.id);

  const [rateRows, restrictionRows, inventoryRows] = await Promise.all([
    kinds.includes("rates") && roomTypeIds.length && ratePlanIds.length
      ? prisma.rateDay.findMany({
          where: { propertyId, roomTypeId: { in: roomTypeIds }, ratePlanId: { in: ratePlanIds }, date: { gte: fromDate, lte: toDate } },
          select: { ratePlanId: true, roomTypeId: true, date: true, price: true, currency: true, occupancyPricesJson: true }
        })
      : Promise.resolve([]),
    // Restrictions are also needed for an availability-only push: a room-level
    // stop sell (RestrictionDay ratePlanId "*") forces the sent availability to 0.
    (kinds.includes("restrictions") || kinds.includes("availability")) && roomTypeIds.length
      ? prisma.restrictionDay.findMany({
          where: {
            propertyId,
            roomTypeId: { in: roomTypeIds },
            date: { gte: fromDate, lte: toDate },
            ratePlanId: { in: ["*", ...ratePlanIds] },
            channelId: { in: ["*", ...channels.map((c) => c.id)] }
          }
        })
      : Promise.resolve([]),
    kinds.includes("availability") && roomTypeIds.length
      ? prisma.inventoryDay.findMany({
          where: { propertyId, roomTypeId: { in: roomTypeIds }, date: { gte: fromDate, lte: toDate } },
          select: { roomTypeId: true, date: true, availableCount: true, stopSell: true }
        })
      : Promise.resolve([])
  ]);

  // Availability: InventoryDay first, real availability for the (roomType, date) without a row.
  const availability: Array<{ roomTypeId: string; date: string; count: number }> = [];
  if (kinds.includes("availability")) {
    const inventoryByKey = new Map(inventoryRows.map((r) => [`${r.roomTypeId}|${iso(r.date)}`, r] as const));
    const real = await computeRealAvailability(propertyId, roomTypeIds, dates);
    for (const rt of roomTypeIds) {
      for (const d of dates) {
        const inv = inventoryByKey.get(`${rt}|${d}`);
        if (inv) availability.push({ roomTypeId: rt, date: d, count: inv.stopSell ? 0 : Math.max(0, inv.availableCount) });
        else {
          const count = real.get(`${rt}|${d}`);
          if (count !== undefined) availability.push({ roomTypeId: rt, date: d, count });
        }
      }
    }
  }

  const planChannels: PlanChannel[] = channels.map((c) => ({
    id: c.id,
    providerCode: c.providerCode,
    status: c.status,
    mode: effectiveChannelMode(c.mode),
    markupPercent: c.defaultMarkupPercent !== null ? Number(c.defaultMarkupPercent) : 0,
    mappings: mappingIndex.get(c.id) ?? new Map()
  }));

  return {
    channels: planChannels,
    roomTypes,
    ratePlans: ratePlans.map((r) => ({ id: r.id, code: r.code })),
    dates,
    kinds,
    rates: rateRows.map((r) => ({
      ratePlanId: r.ratePlanId,
      roomTypeId: r.roomTypeId,
      date: iso(r.date),
      price: Number(r.price),
      currency: r.currency,
      occupancyPrices: parseOccupancyPrices(r.occupancyPricesJson)
    })),
    restrictions: restrictionRows.map(
      (r): PlanRestriction => ({
        roomTypeId: r.roomTypeId,
        ratePlanId: r.ratePlanId,
        channelId: r.channelId,
        date: iso(r.date),
        minStay: r.minStay,
        maxStay: r.maxStay,
        minStayThrough: r.minStayThrough,
        closedToArrival: r.closedToArrival,
        closedToDeparture: r.closedToDeparture,
        closed: r.closed,
        stopSell: r.stopSell,
        minAdvanceDays: r.minAdvanceDays,
        maxAdvanceDays: r.maxAdvanceDays
      })
    ),
    availability,
    ...(property?.currency ? { propertyCurrency: property.currency } : {})
  };
}

function parseOccupancyPrices(raw: Prisma.JsonValue | null): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- sync map

/**
 * Latest delivery state per editor cell and channel over a date range.
 * Stable signature — imported by the api-rate-grid lote.
 *
 * `superseded` rows are left out of the read: a superseded delivery is by
 * definition replaced by a newer row of the same cell, and within the enqueue
 * transaction both get the same `updatedAt` millisecond, so including them
 * could paint "superseded" over a cell whose real state is `queued`. It also
 * keeps the read proportional to the live rows, not to the publish history.
 *
 * Stale detection: when the newest row of a delivery cell is delivered (sent /
 * confirmed), the current grid payload of that cell is recomputed with the
 * same planner the enqueue uses (no existing rows) and compared by value hash;
 * a difference → `stale` (see buildCellSyncMap). The recompute only loads the
 * kinds, room types and plans that have delivered rows, so a window with
 * nothing published costs the same as before.
 */
export async function getCellSyncMap(propertyId: string, from: string, to: string, channelIds?: string[]): Promise<Map<string, Record<string, CellSyncState>>> {
  const range = requireRange(from, to);
  const [rows, ratePlans] = await Promise.all([
    prisma.channelDelivery.findMany({
      where: {
        propertyId,
        ...(channelIds?.length ? { channelId: { in: channelIds } } : {}),
        status: { not: "superseded" },
        date: { gte: dateOnly(range.from), lte: dateOnly(range.to) }
      },
      select: { id: true, channelId: true, kind: true, roomTypeId: true, ratePlanId: true, date: true, status: true, lastError: true, updatedAt: true, payloadJson: true },
      orderBy: { updatedAt: "desc" }
    }),
    prisma.ratePlan.findMany({ where: { propertyId, active: true }, select: { id: true } })
  ]);
  const mapped: SyncMapRow[] = rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    kind: r.kind as DeliveryKind,
    roomTypeId: r.roomTypeId,
    ratePlanId: r.ratePlanId,
    date: iso(r.date),
    status: r.status as DeliveryStatus,
    lastError: r.lastError,
    updatedAt: r.updatedAt.toISOString(),
    valueHash: DELIVERED_STATUSES.includes(r.status as DeliveryStatus) ? valueHash(r.payloadJson) : null
  }));
  const current = await currentValueHashesFor(propertyId, range.dates, mapped);
  return buildCellSyncMap(mapped, ratePlans.map((p) => p.id), current);
}

/** Current value hash per delivered cell of `rows` (undefined when nothing is delivered). */
async function currentValueHashesFor(propertyId: string, dates: string[], rows: SyncMapRow[]): Promise<Map<string, string> | undefined> {
  const delivered = [...latestByDeliveryCell(rows).values()].filter((r) => DELIVERED_STATUSES.includes(r.status));
  if (delivered.length === 0) return undefined;
  const channelIds = [...new Set(delivered.map((r) => r.channelId))];
  const kinds = [...new Set(delivered.map((r) => r.kind))];
  const roomTypeIds = [...new Set(delivered.map((r) => r.roomTypeId))];
  // "*" rows (availability) carry no plan; leave the plan filter open when one is present.
  const planIds = delivered.map((r) => r.ratePlanId).filter((id) => id !== "*");
  const ratePlanIds = planIds.length === delivered.length ? [...new Set(planIds)] : undefined;
  const channels = await prisma.channel.findMany({ where: { propertyId, id: { in: channelIds } } });
  if (channels.length === 0) return undefined;
  const input = await loadPlanInput({ propertyId, channels, dates, kinds, roomTypeIds, ratePlanIds });
  return currentValueHashes(planDeliveries({ ...input, existing: [] }));
}

export async function getRateGridSyncStatus(propertyId: string, from: string, to: string, channelIds?: string[]): Promise<RateGridSyncStatusResponse> {
  // Same contract as GET …/rate-grid/sync-status: a channel of another
  // property is a 400 UNKNOWN_IDS, not an empty 200.
  const channelsAll = await listRateGridChannels(propertyId);
  assertKnownChannelIds(channelIds, channelsAll.map((c) => c.id));
  const map = await getCellSyncMap(propertyId, from, to, channelIds);
  const channels = channelIds?.length ? channelsAll.filter((c) => channelIds.includes(c.id)) : channelsAll;
  const summary: RateGridSyncStatusResponse["summary"] = {};
  const cells: RateGridSyncStatusResponse["cells"] = [];
  for (const [key, byChannel] of map) {
    const [ratePlanId, roomTypeId, date] = key.split("|") as [string, string, string];
    cells.push({ ratePlanId, roomTypeId, date, byChannel });
    for (const [channelId, state] of Object.entries(byChannel)) {
      const bucket = summary[channelId] ?? (summary[channelId] = {});
      bucket[state.status] = (bucket[state.status] ?? 0) + 1;
    }
  }
  return { from, to, channels, cells, summary };
}

// ---------------------------------------------------------------- log & retry

export type DeliveryDTO = {
  id: string;
  propertyId: string;
  channelId: string;
  kind: string;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  status: string;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  externalRef: string | null;
  syncJobId: string | null;
  journalId: string | null;
  payloadHash: string;
  payload: unknown;
  sentAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toDTO(d: Prisma.ChannelDeliveryGetPayload<Record<string, never>>): DeliveryDTO {
  return {
    id: d.id,
    propertyId: d.propertyId,
    channelId: d.channelId,
    kind: d.kind,
    roomTypeId: d.roomTypeId,
    ratePlanId: d.ratePlanId,
    date: iso(d.date),
    status: d.status,
    attempts: d.attempts,
    nextRetryAt: d.nextRetryAt ? d.nextRetryAt.toISOString() : null,
    lastError: d.lastError,
    externalRef: d.externalRef,
    syncJobId: d.syncJobId,
    journalId: d.journalId,
    payloadHash: d.payloadHash,
    payload: d.payloadJson,
    sentAt: d.sentAt ? d.sentAt.toISOString() : null,
    confirmedAt: d.confirmedAt ? d.confirmedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString()
  };
}

export async function listDeliveries(input: {
  propertyId: string;
  channelId?: string;
  status?: string;
  kind?: string;
  from?: string;
  to?: string;
  roomTypeId?: string;
  ratePlanId?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ items: DeliveryDTO[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const where: Prisma.ChannelDeliveryWhereInput = {
    propertyId: input.propertyId,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.roomTypeId ? { roomTypeId: input.roomTypeId } : {}),
    ...(input.ratePlanId ? { ratePlanId: input.ratePlanId } : {}),
    ...(input.from || input.to
      ? { date: { ...(input.from ? { gte: dateOnly(requireIsoDate(input.from, "from")) } : {}), ...(input.to ? { lte: dateOnly(requireIsoDate(input.to, "to")) } : {}) } }
      : {})
  };
  // The cursor is the id of the last row of the previous page. Prisma's
  // `cursor` + `skip: 1` on an id that does not exist answers an empty page,
  // which reads as "no deliveries": the pagination convention of the repo
  // (lib/pagination.ts) is that a malformed cursor is a 400, never a silent
  // empty result. The row must also belong to the property being listed.
  if (input.cursor) {
    const anchor = await prisma.channelDelivery.findUnique({ where: { id: input.cursor }, select: { propertyId: true } });
    if (!anchor || anchor.propertyId !== input.propertyId) throw new BadRequestError("El cursor de paginación no es válido.");
  }
  const rows = await prisma.channelDelivery.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {})
  });
  const page = rows.slice(0, limit);
  return { items: page.map(toDTO), nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
}

export async function getDelivery(id: string): Promise<DeliveryDTO> {
  const row = await prisma.channelDelivery.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Entrega no encontrada.");
  return toDTO(row);
}

/**
 * Manual retry: back to queued with a fresh attempt counter (the drain sends
 * it next round). Only `rejected` / `timeout` rows are retried: a `confirmed`
 * or `superseded` row answers 409 (`DELIVERY_NOT_RETRYABLE`, the value is
 * already on the channel or replaced by a newer delivery — re-publish from the
 * grid instead), a `queued` row is a no-op (returned as is) and `sending` a 400.
 */
export async function retryDelivery(id: string): Promise<DeliveryDTO> {
  const row = await prisma.channelDelivery.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Entrega no encontrada.");
  if (row.status === "sending") throw new BadRequestError("La entrega se está enviando ahora mismo.");
  if (row.status === "queued") return toDTO(row);
  if (row.status === "confirmed" || row.status === "superseded") {
    throw new ConflictError(
      row.status === "confirmed" ? "La entrega ya está confirmada por el canal: vuelve a publicar desde la parrilla si quieres reenviarla." : "La entrega fue sustituida por otra más reciente.",
      { code: "DELIVERY_NOT_RETRYABLE", status: row.status }
    );
  }
  const updated = await prisma.channelDelivery.update({
    where: { id },
    data: { status: "queued", attempts: 0, nextRetryAt: null, lastError: null, sentAt: null, confirmedAt: null }
  });
  return toDTO(updated);
}
