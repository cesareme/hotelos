// Pure planning logic of the channel outbox (rate grid v2). No database, no
// clock: `delivery.service.ts` loads rows and persists the plan; the tests in
// __tests__/delivery.test.mts exercise this file directly.
//
// One ChannelDelivery per (channel, kind, roomType, ratePlan | "*", date):
//   rates        → { externalRoomCode, externalRateCode, pricingModel, amount, occupancyPrices?, currency }
//                  amount = base × (1 + channel markup %), 2 decimals.
//   restrictions → merged restriction object of the cell (channel-specific rows
//                  override "*" rows; plan rows override room rows).
//   availability → { externalRoomCode, count } keyed by room type (ratePlanId "*").
//
// Idempotency: idempotencyKey = sha256(channelId|kind|roomTypeId|ratePlanId|date|payloadHash).
//   other queued/timeout row for the same cell     → superseded, ALWAYS (even when
//                                                    the current payload is already
//                                                    queued or confirmed: a revert to
//                                                    a confirmed value must cancel the
//                                                    intermediate value still in the queue);
//   same key already queued/sending                → skipped (on its way);
//   same key sent/confirmed                        → skipped, unless a NEWER delivery of
//                                                    the cell carried another payload after
//                                                    it (sending/sent/confirmed): then the
//                                                    channel holds that intermediate value
//                                                    and the confirmed row is re-queued;
//   same key rejected/timeout/superseded          → re-queued (same row, unique key).
// Invariant the outbox guarantees: the most recent delivery of a cell carries the
// current grid payload (drain.service enforces the same rule when it takes over
// stale `sending` / `timeout` rows).
// Unmapped products never produce a delivery: they come back as warnings so the
// editor can say "Booking: falta mapeo DBL × BAR" instead of failing silently.
// Same for a rate whose currency is not the property's (an OTA bills in the
// hotel's currency) and for an `obp` mapping without occupancy prices: warned,
// never queued half-right.

import { createHash } from "node:crypto";
import type { CellSyncState, CellSyncStatus, RateJournalPushStatus } from "@hotelos/shared";
import { BadRequestError } from "../../lib/http-error.js";
// Same rounding as the grid's effectivePrice (Number.EPSILON before rounding):
// the price the editor shows for a channel must be the amount the outbox sends.
import { round2 } from "../rate-manager/derivation.js";
import type { ChannelMode, DeliveryKind, PricingModel } from "./adapter.types.js";

export { round2 };

export type PricingModelCode = PricingModel;

/**
 * Sync state of a cell on a channel as the outbox computes it. `stale` is the
 * contract value «la última entrega confirmada ya no coincide con la parrilla»
 * (e.g. after a revert): the front labels it «Pendiente de reenvío». The shared
 * contract lists it since the cierre (2026-09-15), so this is the same type.
 */
export type SyncStatus = CellSyncStatus;

/** Key used by the outbox, the drain and mapping.service to find the mapping of a product. */
export function productKey(roomTypeId: string, ratePlanId: string): string {
  return `${roomTypeId}|${ratePlanId}`;
}

export type DeliveryStatus = "queued" | "sending" | "sent" | "confirmed" | "rejected" | "timeout" | "superseded";

export const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["queued", "sending", "sent", "confirmed"];
export const REQUEUEABLE_STATUSES: readonly DeliveryStatus[] = ["rejected", "timeout", "superseded"];
export const SUPERSEDABLE_STATUSES: readonly DeliveryStatus[] = ["queued", "timeout"];
/** Statuses of a newer delivery that put (or will put) ITS payload on the channel after an older confirmed one. */
export const OVERTAKING_STATUSES: readonly DeliveryStatus[] = ["sending", "sent", "confirmed"];
/**
 * Statuses a planned re-queue may start from. `queued` is a no-op and
 * `sending` must never be flipped back (the drain owns it: a second worker
 * would take it again and the provider would receive the payload twice) —
 * delivery.service guards the UPDATE with this list.
 */
export const REQUEUE_FROM_STATUSES: readonly DeliveryStatus[] = ["rejected", "timeout", "superseded", "sent", "confirmed"];

/**
 * A request-scoped channel filter must name channels of the property: the same
 * 400 `UNKNOWN_IDS` the rate-grid routes answer, never a silent empty result
 * that looks like "nothing was ever published".
 */
export function assertKnownChannelIds(requested: string[] | undefined, known: Iterable<string>): void {
  if (!requested || requested.length === 0) return;
  const knownSet = new Set(known);
  const unknown = [...new Set(requested)].filter((id) => !knownSet.has(id));
  if (unknown.length === 0) return;
  const error = new BadRequestError("channelIds contiene canales que no pertenecen a la propiedad.");
  error.details = { code: "UNKNOWN_IDS", channelIds: unknown };
  throw error;
}

export const DELIVERY_KINDS: readonly DeliveryKind[] = ["rates", "restrictions", "availability"];

/**
 * Higher = worse. `never` is the absence of a delivery; `stale` sits between a
 * confirmed delivery and a pending one: the channel holds a value the grid no
 * longer has, but nothing is on its way yet (a re-publish turns it `queued`).
 */
export const STATUS_SEVERITY: Record<SyncStatus, number> = {
  never: 0,
  confirmed: 1,
  sent: 2,
  stale: 3,
  superseded: 4,
  sending: 5,
  queued: 6,
  timeout: 7,
  rejected: 8
};

function severity(status: string): number {
  return STATUS_SEVERITY[status as SyncStatus] ?? 0;
}

export function worstStatus(a: SyncStatus, b: SyncStatus): SyncStatus {
  return severity(a) >= severity(b) ? a : b;
}

export function worstState(a: CellSyncState | undefined, b: CellSyncState): CellSyncState {
  if (!a) return b;
  return severity(b.status) > severity(a.status) ? b : a;
}

/** Statuses whose payload the channel is assumed to hold (candidates for `stale`). */
export const DELIVERED_STATUSES: readonly DeliveryStatus[] = ["sent", "confirmed"];

/** Mapping codes travel in every payload but are not a VALUE of the grid: a code change is a remapping, not a stale rate. */
const MAPPING_CODE_KEYS: readonly string[] = ["externalRoomCode", "externalRateCode"];

/**
 * Hash of what the grid VALUE of a delivery is (price, occupancy prices,
 * currency, merged restrictions, availability count) — the payload without the
 * channel's external codes. Two deliveries of a cell with the same value hash
 * carry the same grid state even when the product was remapped in between.
 */
export function valueHash(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payloadHash(payload);
  const stripped = Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => !MAPPING_CODE_KEYS.includes(k)));
  return payloadHash(stripped);
}

/** `list` narrowed to `ids` when a non-empty filter is given (unknown ids simply select nothing: the caller validates them). */
export function filterByIds<T extends { id: string }>(list: T[], ids?: string[] | null): T[] {
  if (!ids || ids.length === 0) return list;
  const wanted = new Set(ids);
  return list.filter((item) => wanted.has(item.id));
}

// ---------------------------------------------------------------- journal push status

/** Same union as the shared contract (`RateChangeJournalEntry.pushStatus`). */
export type JournalPushStatus = RateJournalPushStatus;

/**
 * `RateChangeJournal.pushStatus` from the deliveries the entry produced
 * (counts by status, superseded INCLUDED so a fully replaced publish is told
 * apart from one that never queued anything):
 *   no deliveries              → null (nothing to say; the caller keeps the stored value)
 *   all superseded             → superseded (every value was replaced by a later publish)
 *   any queued/sending/timeout → queued (still on its way; rejections so far do not settle it)
 *   all live rows confirmed    → pushed
 *   all live rows rejected     → failed
 *   otherwise                  → partial
 * "Live" = not superseded (a replaced row says nothing about the channel).
 */
export function classifyJournalPushStatus(counts: Partial<Record<DeliveryStatus, number>>): JournalPushStatus | null {
  const n = (status: DeliveryStatus): number => counts[status] ?? 0;
  const total = (Object.keys(counts) as DeliveryStatus[]).reduce((acc, status) => acc + n(status), 0);
  if (total === 0) return null;
  const superseded = n("superseded");
  if (superseded === total) return "superseded";
  const live = total - superseded;
  const pending = n("queued") + n("sending") + n("timeout");
  if (pending > 0) return "queued";
  const confirmed = n("confirmed") + n("sent");
  if (confirmed === live) return "pushed";
  if (n("rejected") === live) return "failed";
  return "partial";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export function idempotencyKey(input: { channelId: string; kind: DeliveryKind; roomTypeId: string; ratePlanId: string; date: string; payloadHash: string }): string {
  return createHash("sha256")
    .update([input.channelId, input.kind, input.roomTypeId, input.ratePlanId, input.date, input.payloadHash].join("|"), "utf8")
    .digest("hex");
}

/** Key of the editor cell: `${ratePlanId}|${roomTypeId}|${date}` (stable: the rate-grid lote reads it). */
export function cellKey(ratePlanId: string, roomTypeId: string, date: string): string {
  return `${ratePlanId}|${roomTypeId}|${date}`;
}

export function deliveryCellKey(channelId: string, kind: DeliveryKind, roomTypeId: string, ratePlanId: string, date: string): string {
  return `${channelId}|${kind}|${roomTypeId}|${ratePlanId}|${date}`;
}

export function applyMarkup(base: number, markupPercent: number): number {
  return round2(base * (1 + markupPercent / 100));
}

export function listDates(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// ---------------------------------------------------------------- inputs

export type PlanMapping = { roomTypeId: string; ratePlanId: string; externalRoomCode: string; externalRateCode: string; pricingModel: PricingModelCode };

export type PlanChannel = {
  id: string;
  providerCode: string;
  status: string;
  mode: ChannelMode;
  markupPercent: number;
  mappings: Map<string, PlanMapping>;
};

export type PlanRate = {
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  price: number;
  currency: string;
  occupancyPrices: Record<string, number> | null;
};

export type PlanRestriction = {
  roomTypeId: string;
  /** "*" or a rate plan id */
  ratePlanId: string;
  /** "*" or a channel id */
  channelId: string;
  date: string;
  minStay: number | null;
  maxStay: number | null;
  minStayThrough: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  closed: boolean;
  stopSell: boolean;
  minAdvanceDays: number | null;
  maxAdvanceDays: number | null;
};

export type PlanAvailability = { roomTypeId: string; date: string; count: number };

export type ExistingDelivery = {
  id: string;
  channelId: string;
  kind: DeliveryKind;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  status: DeliveryStatus;
  idempotencyKey: string;
  payloadHash: string;
  /**
   * ISO timestamp of the last state change (enqueue, claim, outcome, re-queue).
   * Orders the deliveries of one cell: a `confirmed` row is only "the value the
   * channel holds" while no later row of the cell overtook it.
   */
  updatedAt: string;
};

export type DeliveryDraft = {
  channelId: string;
  kind: DeliveryKind;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string;
};

export type PlanInput = {
  channels: PlanChannel[];
  /** Products in scope (active room types × distributable plans, filtered by the request). */
  roomTypes: Array<{ id: string; code: string }>;
  ratePlans: Array<{ id: string; code: string }>;
  dates: string[];
  kinds: DeliveryKind[];
  rates: PlanRate[];
  restrictions: PlanRestriction[];
  availability: PlanAvailability[];
  existing: ExistingDelivery[];
  /**
   * Billing currency of the property. A rate in another currency is not
   * queued (the OTAs bill in the hotel's extranet currency; sending "USD 90"
   * to a EUR hotel is either rejected or, worse, taken as EUR 90).
   */
  propertyCurrency?: string;
};

export type PlanOutput = {
  drafts: DeliveryDraft[];
  /** Existing queued/timeout deliveries of the same cell with an older payload. */
  supersede: string[];
  /**
   * Existing deliveries with the SAME payload that must go back to queued:
   * rejected/timeout/superseded rows, plus a sent/confirmed row that a newer
   * delivery of the cell overtook with another payload.
   */
  requeue: string[];
  /** Same payload already queued/sending, or confirmed and not overtaken: nothing to do. */
  skipped: number;
  byChannel: Record<string, { queued: number; mode: ChannelMode; skippedUnmapped: number }>;
  warnings: string[];
};

// ---------------------------------------------------------------- restriction merge

/** Specificity: (channel, plan) > (channel, *) > (*, plan) > (*, *). */
function restrictionRank(r: PlanRestriction, channelId: string, ratePlanId: string): number {
  const ch = r.channelId === channelId ? 2 : r.channelId === "*" ? 1 : -1;
  const rp = r.ratePlanId === ratePlanId ? 2 : r.ratePlanId === "*" ? 1 : -1;
  if (ch < 0 || rp < 0) return -1;
  return ch * 3 + rp;
}

export type MergedRestriction = {
  minStay?: number;
  minStayThrough?: number;
  maxStay?: number;
  cta: boolean;
  ctd: boolean;
  closed: boolean;
  stopSell: boolean;
  minAdvanceDays?: number;
  maxAdvanceDays?: number;
};

export function mergeRestrictions(rows: PlanRestriction[], channelId: string, ratePlanId: string): MergedRestriction | null {
  const applicable = rows
    .map((r) => ({ r, rank: restrictionRank(r, channelId, ratePlanId) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (applicable.length === 0) return null;
  const out: MergedRestriction = { cta: false, ctd: false, closed: false, stopSell: false };
  for (const { r } of applicable) {
    if (r.minStay !== null) out.minStay = r.minStay;
    if (r.maxStay !== null) out.maxStay = r.maxStay;
    if (r.minStayThrough !== null) out.minStayThrough = r.minStayThrough;
    if (r.minAdvanceDays !== null) out.minAdvanceDays = r.minAdvanceDays;
    if (r.maxAdvanceDays !== null) out.maxAdvanceDays = r.maxAdvanceDays;
    // Flags are OR-ed: a room-level stop sell is never undone by a plan row.
    out.cta = out.cta || r.closedToArrival;
    out.ctd = out.ctd || r.closedToDeparture;
    out.closed = out.closed || r.closed;
    out.stopSell = out.stopSell || r.stopSell;
  }
  return out;
}

// ---------------------------------------------------------------- planner

export function planDeliveries(input: PlanInput): PlanOutput {
  const drafts: DeliveryDraft[] = [];
  const supersede: string[] = [];
  const requeue: string[] = [];
  const warnings: string[] = [];
  const byChannel: PlanOutput["byChannel"] = {};
  let skipped = 0;

  const rateByCell = new Map<string, PlanRate>();
  for (const r of input.rates) rateByCell.set(cellKey(r.ratePlanId, r.roomTypeId, r.date), r);
  const restrictionsByRoomDate = new Map<string, PlanRestriction[]>();
  for (const r of input.restrictions) {
    const k = `${r.roomTypeId}|${r.date}`;
    const list = restrictionsByRoomDate.get(k) ?? [];
    list.push(r);
    restrictionsByRoomDate.set(k, list);
  }
  const availabilityByRoomDate = new Map<string, number>();
  for (const a of input.availability) availabilityByRoomDate.set(`${a.roomTypeId}|${a.date}`, a.count);

  const existingByKey = new Map<string, ExistingDelivery>();
  const existingByCell = new Map<string, ExistingDelivery[]>();
  for (const e of input.existing) {
    existingByKey.set(`${e.channelId}|${e.idempotencyKey}`, e);
    const k = deliveryCellKey(e.channelId, e.kind, e.roomTypeId, e.ratePlanId, e.date);
    const list = existingByCell.get(k) ?? [];
    list.push(e);
    existingByCell.set(k, list);
  }
  const plannedCells = new Set<string>();
  // Per (channel, product) counters of cells NOT queued for a data reason, so
  // the response says "Booking: DBL × BAR, 3 días en USD" instead of 3 lines.
  const currencyMismatch = new Map<string, { label: string; days: number; currency: string }>();
  const obpWithoutOccupancy = new Map<string, { label: string; days: number }>();

  function place(channel: PlanChannel, kind: DeliveryKind, roomTypeId: string, ratePlanId: string, date: string, payload: Record<string, unknown>): void {
    const cell = deliveryCellKey(channel.id, kind, roomTypeId, ratePlanId, date);
    if (plannedCells.has(cell)) return; // e.g. availability reached through two plans of the same room type
    plannedCells.add(cell);
    const hash = payloadHash(payload);
    const key = idempotencyKey({ channelId: channel.id, kind, roomTypeId, ratePlanId, date, payloadHash: hash });
    const same = existingByKey.get(`${channel.id}|${key}`);
    const others = (existingByCell.get(cell) ?? []).filter((o) => o.idempotencyKey !== key);
    // Whatever happens to `same`, a pending row of the cell with another payload
    // is replaced: leaving it queued would let an intermediate value (e.g. 130
    // queued while the grid reverted to the confirmed 97) reach the channel later.
    for (const other of others) {
      if (SUPERSEDABLE_STATUSES.includes(other.status)) supersede.push(other.id);
    }
    if (same && ACTIVE_DELIVERY_STATUSES.includes(same.status)) {
      // queued / sending: the current payload is already on its way.
      // sent / confirmed: the channel holds it — unless a newer delivery of the
      // cell carried another payload after it (in flight or already confirmed),
      // in which case the channel holds THAT value and the row must be resent.
      const delivered = same.status === "sent" || same.status === "confirmed";
      const overtaken = delivered && others.some((o) => OVERTAKING_STATUSES.includes(o.status) && o.updatedAt > same.updatedAt);
      if (!overtaken) {
        skipped++;
        return;
      }
    }
    const summary = byChannel[channel.id] ?? (byChannel[channel.id] = { queued: 0, mode: channel.mode, skippedUnmapped: 0 });
    summary.queued++;
    if (same) {
      requeue.push(same.id);
      return;
    }
    drafts.push({ channelId: channel.id, kind, roomTypeId, ratePlanId, date, payload, payloadHash: hash, idempotencyKey: key });
  }

  for (const channel of input.channels) {
    byChannel[channel.id] = { queued: 0, mode: channel.mode, skippedUnmapped: 0 };
    if (channel.status !== "active") {
      warnings.push(`Canal ${channel.providerCode}: inactivo, no se encola nada.`);
      continue;
    }
    for (const rt of input.roomTypes) {
      for (const rp of input.ratePlans) {
        const mapping = channel.mappings.get(productKey(rt.id, rp.id));
        if (!mapping) {
          byChannel[channel.id].skippedUnmapped++;
          warnings.push(`Canal ${channel.providerCode}: sin mapeo para ${rt.code} × ${rp.code}.`);
          continue;
        }
        const productLabel = `Canal ${channel.providerCode}: ${rt.code} × ${rp.code}`;
        for (const date of input.dates) {
          if (input.kinds.includes("rates")) {
            const rate = rateByCell.get(cellKey(rp.id, rt.id, date));
            if (rate) {
              const occupancy = rate.occupancyPrices && Object.keys(rate.occupancyPrices).length > 0 ? rate.occupancyPrices : null;
              const hasGuestPrices = occupancy !== null && Object.keys(occupancy).some((k) => /^\d+$/.test(k));
              if (input.propertyCurrency && rate.currency !== input.propertyCurrency) {
                const k = `${channel.id}|${rt.id}|${rp.id}|${rate.currency}`;
                const bucket = currencyMismatch.get(k) ?? { label: productLabel, days: 0, currency: rate.currency };
                bucket.days++;
                currencyMismatch.set(k, bucket);
              } else if (mapping.pricingModel === "obp" && !hasGuestPrices) {
                const k = `${channel.id}|${rt.id}|${rp.id}`;
                const bucket = obpWithoutOccupancy.get(k) ?? { label: productLabel, days: 0 };
                bucket.days++;
                obpWithoutOccupancy.set(k, bucket);
              } else {
                const payload: Record<string, unknown> = {
                  externalRoomCode: mapping.externalRoomCode,
                  externalRateCode: mapping.externalRateCode,
                  pricingModel: mapping.pricingModel,
                  amount: applyMarkup(rate.price, channel.markupPercent),
                  currency: rate.currency
                };
                if (occupancy) {
                  payload.occupancyPrices = Object.fromEntries(Object.entries(occupancy).map(([k, v]) => [k, applyMarkup(v, channel.markupPercent)]));
                }
                place(channel, "rates", rt.id, rp.id, date, payload);
              }
            }
          }
          if (input.kinds.includes("restrictions")) {
            const merged = mergeRestrictions(restrictionsByRoomDate.get(`${rt.id}|${date}`) ?? [], channel.id, rp.id);
            if (merged) {
              place(channel, "restrictions", rt.id, rp.id, date, { externalRoomCode: mapping.externalRoomCode, externalRateCode: mapping.externalRateCode, ...merged });
            }
          }
          if (input.kinds.includes("availability")) {
            const count = availabilityByRoomDate.get(`${rt.id}|${date}`);
            if (count !== undefined) {
              // A room-level stop sell written from the grid (RestrictionDay
              // (roomType, "*", "*" | channel)) pulls the room from sale: the
              // availability sent must agree with it (0), even when the
              // restrictions kind is not part of this push.
              const roomLevel = mergeRestrictions(restrictionsByRoomDate.get(`${rt.id}|${date}`) ?? [], channel.id, "*");
              const effective = roomLevel?.stopSell ? 0 : count;
              place(channel, "availability", rt.id, "*", date, { externalRoomCode: mapping.externalRoomCode, count: effective });
            }
          }
        }
      }
    }
  }
  for (const m of currencyMismatch.values()) {
    warnings.push(`${m.label}: ${m.days} día(s) en ${m.currency} y la propiedad factura en ${input.propertyCurrency}: no se envían (corrija la moneda de la tarifa).`);
  }
  for (const m of obpWithoutOccupancy.values()) {
    warnings.push(`${m.label}: mapeo por ocupación (obp) sin precios por ocupación en ${m.days} día(s): no se envían (informe los precios por ocupación o cambie el mapeo a per_day).`);
  }

  return { drafts, supersede: [...new Set(supersede)], requeue: [...new Set(requeue)], skipped, byChannel, warnings: [...new Set(warnings)] };
}

// ---------------------------------------------------------------- sync map (pure part)

export type SyncMapRow = {
  id: string;
  channelId: string;
  kind: DeliveryKind;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  status: DeliveryStatus;
  lastError: string | null;
  updatedAt: string;
  /** `valueHash` of the stored payload; needed only for delivered rows (stale detection). */
  valueHash?: string | null;
};

/** Newest row per delivery cell (channel, kind, room type, plan | "*", date). */
export function latestByDeliveryCell(rows: SyncMapRow[]): Map<string, SyncMapRow> {
  const sorted = [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const latest = new Map<string, SyncMapRow>();
  for (const r of sorted) {
    const k = deliveryCellKey(r.channelId, r.kind, r.roomTypeId, r.ratePlanId, r.date);
    if (!latest.has(k)) latest.set(k, r);
  }
  return latest;
}

/** Current grid value per delivery cell, taken from a plan computed with no existing rows. */
export function currentValueHashes(plan: Pick<PlanOutput, "drafts">): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of plan.drafts) out.set(deliveryCellKey(d.channelId, d.kind, d.roomTypeId, d.ratePlanId, d.date), valueHash(d.payload));
  return out;
}

/**
 * Builds the per-cell, per-channel state from delivery rows (newest first).
 * rates: the latest delivery of the cell. restrictions / availability (room
 * level, applies to every plan of the room type): folded in as the WORST state
 * so a rejected availability push shows on the cell even when the rate is fine.
 *
 * `current` (optional) is the value hash the grid holds NOW per delivery cell
 * (`currentValueHashes`): a delivered row (sent / confirmed) whose value hash
 * differs from it is reported as `stale` — the channel keeps a price,
 * restriction or availability the grid no longer has (a revert, a later edit
 * saved without publishing). A cell with no current value (rate deleted,
 * product unmapped, channel inactive) is left as delivered: there is nothing
 * to resend, and «confirmed» is still what the channel holds.
 */
export function buildCellSyncMap(rows: SyncMapRow[], ratePlanIds: string[], current?: Map<string, string>): Map<string, Record<string, CellSyncState>> {
  const latest = latestByDeliveryCell(rows);
  const out = new Map<string, Record<string, CellSyncState>>();
  const fold = (ratePlanId: string, roomTypeId: string, date: string, channelId: string, r: SyncMapRow, status: SyncStatus) => {
    const ck = cellKey(ratePlanId, roomTypeId, date);
    const byChannel = out.get(ck) ?? {};
    const state: CellSyncState = { status: status as CellSyncStatus, at: r.updatedAt, error: r.lastError, deliveryId: r.id };
    byChannel[channelId] = worstState(byChannel[channelId], state);
    out.set(ck, byChannel);
  };
  for (const [deliveryCell, r] of latest) {
    let status: SyncStatus = r.status;
    if (current && DELIVERED_STATUSES.includes(r.status)) {
      const now = current.get(deliveryCell);
      if (now !== undefined && r.valueHash && now !== r.valueHash) status = "stale";
    }
    if (r.kind === "availability" || r.ratePlanId === "*") {
      for (const planId of ratePlanIds) fold(planId, r.roomTypeId, r.date, r.channelId, r, status);
    } else {
      fold(r.ratePlanId, r.roomTypeId, r.date, r.channelId, r, status);
    }
  }
  return out;
}
