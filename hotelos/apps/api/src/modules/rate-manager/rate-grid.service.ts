// Rate Manager · rate grid v2 — canonical backend of the rate editor.
//
// Routes (registered by rate-grid.routes.ts, permissions in
// route-permissions.partial.ts):
//   GET  /properties/:id/rate-grid                 → getRateGrid       (RateGridResponse)
//   POST /properties/:id/rate-grid/bulk-update     → bulkUpdateRateGrid
//   POST /properties/:id/rate-grid/push            → pushRateGrid      (delegates to the outbox)
//   GET  /properties/:id/rate-grid/sync-status     → getRateGridSyncStatus
//   POST /properties/:id/rate-plans/:planId/rederive → rederiveRatePlan
// Journal routes live in journal.service.ts. Wire contract:
// packages/shared/src/rate-manager-types.ts (programmed as-is).
//
// Model notes:
//   · `RateDay` is the BAR level of a (plan, roomType, date); a cell without a
//     row is `basePrice: null` — never a fake 0.
//   · Restrictions come from `RestrictionDay` layered (plan,"*") + ("*","*") +
//     channel rows when `channelId` is requested (precedence in rate-grid.merge.ts).
//   · Channel prices are base × (1 + markup); markup = Channel.defaultMarkupPercent
//     ?? 0 — the SAME rule the outbox applies to the delivered amount
//     (commissionPercent is a cost, never a markup). The channel list of the
//     grid (readiness, effective mode, adapter, markup) is
//     channel-manager/channels.service#listRateGridChannels: one source of
//     truth shared with GET /properties/:id/channels.
//   · Sync state per cell/channel comes from the outbox (ChannelDelivery) via
//     channel-outbox.bridge.ts; when that read fails the grid still answers,
//     logs the error and marks `degraded: ["sync"]` (QC-06).
//
// bulk-update rules (api-polish, 2026-09-15):
//   · `ops` are expanded and applied BEFORE `cells`: a cell edited by hand
//     after a bulk op wins over the op on the same cell (the engine applies
//     patches in order and later writes see earlier ones).
//   · Availability patches accept ratePlanId "*" (sentinel of the «Disponibles»
//     row: room-level InventoryDay) as well as a base plan id; "*" never
//     carries price fields (400).
//   · Conflicts: when EVERY patch is a conflict (nothing written) the request
//     is rolled back and answers 409 `ALL_CELLS_CONFLICT` with
//     `details.conflicts`; partial conflicts answer 200 with `conflicts[]`.
//   · Channel price overrides (`channelId` + price on a cell, or
//     `scope.channelIds` + price on an op) answer 400: channel prices are
//     base × markup (RateDay has no channel dimension). Restrictions per
//     channel are fine.
//   · Ops that expand to NO patch at all (unknown ids, empty weekdays, no
//     base price for a percent op…) with no `cells` → 400 `NO_CELLS` with the
//     warnings/skipped, instead of a journal entry with 0 changes. The
//     expansion is capped at MAX_CELLS patches (400 `TOO_MANY_CELLS`).
//   · A cell may carry `expected` (price / lastModifiedAt as loaded): when
//     the server value differs the cell is a conflict, never a silent overwrite.
//   · `publish` (cierre 2026-09-15) enqueues ONLY what the patches touched:
//     roomTypeIds / ratePlanIds (plus derived children) and the kinds the
//     fields imply, derived in publish-scope.ts — one edited cell is one
//     delivery per channel and kind, not the whole window × 4 types.
//     `publish.kinds` given by the client wins over the derived kinds.
//   · A repeated `clientRequestId` returns the stored response (engine
//     `replayed`) and does NOT enqueue the publish again; the flag never
//     reaches the wire, a `warnings` line explains the replay.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type {
  RateGridBulkUpdateRequest,
  RateGridBulkUpdateResponse,
  RateGridCell,
  RateGridCellPatch,
  RateGridChannel,
  RateGridDemandDay,
  RateGridPushRequest,
  RateGridPushResponse,
  RateGridResponse,
  RateGridSyncStatusResponse
} from "@hotelos/shared";
import { createDegradedCollector } from "../../lib/degraded.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { listRateGridChannels } from "../channel-manager/channels.service.js";
import { parseRevenueWindow } from "../revenue/actuals.js";
import { BOARD_MAX_DAYS, getHistoryForecastBoard } from "../revenue/hf-board.service.js";
import { cellKey, dayUtc, enumerateDates, expandBulkOps, isoDate, type BulkGridSnapshot } from "./bulk-ops.js";
import { getRateGridOutbox, type RateGridOutbox } from "./channel-outbox.bridge.js";
import { round2 } from "./derivation.js";
import {
  columnsToRestrictions,
  effectivePrice,
  resolveRestrictions,
  summarizeSync,
  type CellSyncMap,
  type RestrictionColumns
} from "./rate-grid.merge.js";
import { derivePushScope } from "./publish-scope.js";
import {
  STAR,
  executeRateGridWrite,
  loadPropertyCatalog,
  toWireResponse,
  type EnginePatch,
  type PropertyCatalog
} from "./rate-grid.engine.js";
import { MAX_CELLS, MAX_GRID_DAYS, assertPatchBudget, bulkUpdateSchema, parseOr400, pushSchema } from "./rate-grid.schemas.js";

export { mergeCellSync, effectivePrice, resolveRestrictions } from "./rate-grid.merge.js";
export { expandBulkOps } from "./bulk-ops.js";
export { applyDerivation, parseDerivation } from "./derivation.js";
export { getRateJournal, getRateJournalEntry, revertRateJournal } from "./journal.service.js";
export { applyRestrictionPatches } from "./restrictions.service.js";

const MS_DAY = 86_400_000;

function dec(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Grid window: from/to mandatory on the wire; defaults (today .. +29) keep the legacy caller working. */
export function parseGridWindow(input: { from?: unknown; to?: unknown }) {
  return parseRevenueWindow({
    from: input.from,
    to: input.to,
    maxDays: MAX_GRID_DAYS,
    defaultFrom: todayIso(),
    defaultTo: (from) => isoDate(new Date(dayUtc(from).getTime() + 29 * MS_DAY)),
    scope: "del grid"
  });
}

// ---- channels ----------------------------------------------------------------

/**
 * Channels of the grid header (RateGridChannel[]): the SAME list, readiness
 * text, effective mode (CHANNEL_MAX_MODE), adapter check and markup rule as
 * GET /properties/:id/channels — channels.service is the only implementation,
 * so the editor never shows two readiness texts for one channel. Optional
 * `channelIds` filters (unknown ids simply do not come back; callers that
 * need a 400 compare the sizes).
 */
export async function listGridChannels(propertyId: string, channelIds?: string[]): Promise<RateGridChannel[]> {
  const channels = await listRateGridChannels(propertyId);
  if (!channelIds || channelIds.length === 0) return channels;
  const wanted = new Set(channelIds);
  return channels.filter((c) => wanted.has(c.id));
}

// ---- demand ------------------------------------------------------------------

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Demand strip of the grid. Reuses the History & Forecast board for OTB,
 * forecast, STLY and pickup (one call per ≤190-day slice, the board's cap);
 * events come straight from DemandCalendarEvent and the comp-set median from
 * CompetitorRateSnapshot (the board only exposes it on critical dates).
 */
export async function getRateGridDemand(propertyId: string, from: string, to: string): Promise<RateGridDemandDay[]> {
  const dates = enumerateDates(from, to);
  const slices: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < dates.length; i += BOARD_MAX_DAYS) {
    slices.push({ from: dates[i]!, to: dates[Math.min(i + BOARD_MAX_DAYS, dates.length) - 1]! });
  }
  const [boards, events, compset] = await Promise.all([
    Promise.all(slices.map((s) => getHistoryForecastBoard(propertyId, s))),
    prisma.demandCalendarEvent.findMany({
      where: { propertyId, startDate: { lte: dayUtc(to) }, endDate: { gte: dayUtc(from) } },
      select: { name: true, expectedImpact: true, startDate: true, endDate: true }
    }),
    prisma.competitorRateSnapshot.findMany({
      where: { propertyId, stayDate: { gte: dayUtc(from), lte: dayUtc(to) }, price: { not: null } },
      select: { stayDate: true, price: true }
    })
  ]);
  const compByDate = new Map<string, number[]>();
  for (const c of compset) {
    const p = dec(c.price);
    if (p === null || p <= 0) continue;
    const k = isoDate(c.stayDate);
    compByDate.set(k, [...(compByDate.get(k) ?? []), p]);
  }
  const rowByDate = new Map<string, { row: (typeof boards)[number]["rows"][number]; fcSource: string | null }>();
  for (const board of boards) {
    for (const row of board.rows) {
      if (row.rowType === "data" && row.date) rowByDate.set(row.date, { row, fcSource: board.forecastMissing ? null : board.sources.forecast ?? null });
    }
  }
  return dates.map((date) => {
    const hit = rowByDate.get(date);
    const day = dayUtc(date).getTime();
    return {
      date,
      otbRooms: hit?.row.roomsSold ?? 0,
      occPct: hit?.row.occPct ?? 0,
      fcOccPct: hit?.row.fcOccPct ?? null,
      fcSource: hit?.row.fcOccPct !== null && hit?.row.fcOccPct !== undefined ? hit.fcSource : null,
      stlyOccPct: hit?.row.stlyOccPct ?? null,
      stlyAdr: hit?.row.stlyAdr ?? null,
      pickup7: hit?.row.pickup7 ?? null,
      compsetMedian: median(compByDate.get(date) ?? []),
      events: events
        .filter((e) => e.startDate.getTime() <= day + MS_DAY - 1 && e.endDate.getTime() >= day)
        .map((e) => ({ name: e.name, impact: e.expectedImpact ?? null }))
    };
  });
}

// ---- GET grid ------------------------------------------------------------------

export type GetRateGridInput = {
  propertyId: string;
  from?: unknown;
  to?: unknown;
  ratePlanIds?: string[];
  roomTypeIds?: string[];
  channelId?: string | null;
  demand?: boolean;
  /** Injectable for tests; defaults to the resolved outbox bridge. */
  outbox?: RateGridOutbox;
};

function restrictionKey(roomTypeId: string, ratePlanId: string, channelId: string, date: string): string {
  return `${roomTypeId}|${ratePlanId}|${channelId}|${date}`;
}

export async function getRateGrid(input: GetRateGridInput): Promise<RateGridResponse> {
  if (!input.propertyId) throw new BadRequestError("propertyId es obligatorio.");
  const win = parseGridWindow({ from: input.from, to: input.to });
  const catalog = await loadPropertyCatalog(input.propertyId);

  // Filters must reference the property's own catalogue (400 with details, never a silent empty grid).
  const unknownTypes = (input.roomTypeIds ?? []).filter((id) => !catalog.roomTypes.some((t) => t.id === id));
  const unknownPlans = (input.ratePlanIds ?? []).filter((id) => !catalog.planById.has(id));
  if (unknownTypes.length + unknownPlans.length > 0) {
    const error = new BadRequestError("roomTypeIds/ratePlanIds contienen ids que no pertenecen a la propiedad.");
    error.details = { code: "UNKNOWN_IDS", roomTypeIds: unknownTypes, ratePlanIds: unknownPlans };
    throw error;
  }
  const roomTypes = input.roomTypeIds && input.roomTypeIds.length > 0 ? catalog.roomTypes.filter((t) => input.roomTypeIds!.includes(t.id)) : catalog.roomTypes;
  const plans = input.ratePlanIds && input.ratePlanIds.length > 0 ? catalog.plans.filter((p) => input.ratePlanIds!.includes(p.id)) : catalog.plans;

  const channels = await listGridChannels(input.propertyId);
  const channel = input.channelId ? channels.find((c) => c.id === input.channelId) ?? null : null;
  if (input.channelId && !channel) throw new NotFoundError("Canal no encontrado.");

  const dateFilter = { gte: dayUtc(win.from), lte: dayUtc(win.to) };
  const roomTypeIds = roomTypes.map((t) => t.id);
  const planIds = plans.map((p) => p.id);
  const outbox = input.outbox ?? (await getRateGridOutbox());
  // QC-06: a failing sync read must not hide behind «never» on every cell —
  // the grid still answers, the failure is logged and flagged in `degraded`.
  const collector = createDegradedCollector("rate-grid.get", { propertyId: input.propertyId, from: win.from, to: win.to });
  const [rateRows, restrictionRows, inventoryRows, syncMap] = await Promise.all([
    planIds.length > 0 && roomTypeIds.length > 0
      ? prisma.rateDay.findMany({ where: { propertyId: input.propertyId, date: dateFilter, ratePlanId: { in: planIds }, roomTypeId: { in: roomTypeIds } } })
      : Promise.resolve([]),
    prisma.restrictionDay.findMany({ where: { propertyId: input.propertyId, date: dateFilter, roomTypeId: { in: roomTypeIds } } }),
    prisma.inventoryDay.findMany({ where: { propertyId: input.propertyId, date: dateFilter, roomTypeId: { in: roomTypeIds } } }),
    collector.safe<CellSyncMap>("sync", outbox.getCellSyncMap(input.propertyId, win.from, win.to), {})
  ]);

  const rates = new Map(rateRows.map((r) => [cellKey(r.ratePlanId, r.roomTypeId, isoDate(r.date)), r]));
  const restrictions = new Map<string, RestrictionColumns>();
  for (const r of restrictionRows) {
    restrictions.set(restrictionKey(r.roomTypeId, r.ratePlanId, r.channelId, isoDate(r.date)), {
      minStay: r.minStay,
      maxStay: r.maxStay,
      minStayThrough: r.minStayThrough,
      closedToArrival: r.closedToArrival,
      closedToDeparture: r.closedToDeparture,
      closed: r.closed,
      stopSell: r.stopSell,
      minAdvanceDays: r.minAdvanceDays,
      maxAdvanceDays: r.maxAdvanceDays
    });
  }
  const inventory = new Map(inventoryRows.map((r) => [`${r.roomTypeId}|${isoDate(r.date)}`, r]));
  const dates = enumerateDates(win.from, win.to);

  const cells: RateGridCell[] = [];
  for (const roomType of roomTypes) {
    for (const plan of plans) {
      const parent = plan.parentRatePlanId ? catalog.planById.get(plan.parentRatePlanId) ?? null : null;
      for (const date of dates) {
        const row = rates.get(cellKey(plan.id, roomType.id, date));
        const basePrice = row ? Number(row.price) : null;
        const inv = inventory.get(`${roomType.id}|${date}`);
        const layers = {
          star: restrictions.get(restrictionKey(roomType.id, STAR, STAR, date)) ?? null,
          plan: restrictions.get(restrictionKey(roomType.id, plan.id, STAR, date)) ?? null,
          channelStar: channel ? restrictions.get(restrictionKey(roomType.id, STAR, channel.id, date)) ?? null : null,
          channel: channel ? restrictions.get(restrictionKey(roomType.id, plan.id, channel.id, date)) ?? null : null
        };
        const source = row ? (row.source === "rms" || row.source === "derived" || row.source === "import" ? row.source : "manual") : parent ? "derived" : "manual";
        const occupancy = row && row.occupancyPricesJson && typeof row.occupancyPricesJson === "object" && !Array.isArray(row.occupancyPricesJson)
          ? (row.occupancyPricesJson as Record<string, number>)
          : null;
        const sync = syncMap[cellKey(plan.id, roomType.id, date)];
        cells.push({
          ratePlanId: plan.id,
          roomTypeId: roomType.id,
          date,
          basePrice,
          effectivePrice: channel ? effectivePrice(basePrice, channel.markupPercent) : basePrice,
          currency: catalog.currency,
          occupancyPrices: occupancy,
          minPrice: row ? dec(row.minPrice) : null,
          maxPrice: row ? dec(row.maxPrice) : null,
          restrictions: resolveRestrictions(layers),
          inventory: inv ? { total: inv.totalInventory, available: inv.availableCount, outOfOrder: inv.outOfOrderCount, stopSell: inv.stopSell } : null,
          source,
          derivedFrom: parent && (!row || !row.manuallyOverridden) ? { ratePlanId: parent.id, ratePlanCode: parent.code, derivation: plan.derivation } : null,
          channelId: channel ? channel.id : null,
          ...(sync ? { sync } : {}),
          lastModifiedAt: row ? row.updatedAt.toISOString() : null,
          lastModifiedBy: row ? row.updatedBy ?? null : null
        });
      }
    }
  }

  const response: RateGridResponse = {
    propertyId: input.propertyId,
    from: win.from,
    to: win.to,
    currency: catalog.currency,
    roomTypes: roomTypes.map((t) => ({ id: t.id, code: t.code, name: t.name, rooms: t.rooms, baseCapacity: t.baseCapacity, maxOccupancy: t.maxOccupancy, sortOrder: t.sortOrder })),
    ratePlans: plans.map((p) => ({ id: p.id, code: p.code, name: p.name, ratePlanType: p.ratePlanType, mealPlan: p.mealPlan, parentRatePlanId: p.parentRatePlanId, derivation: p.derivation, active: p.active })),
    channels,
    cells,
    ...(collector.degraded.length > 0 ? { degraded: [...collector.degraded] } : {}),
    generatedAt: new Date().toISOString()
  };
  if (input.demand) response.demand = await getRateGridDemand(input.propertyId, win.from, win.to);
  return response;
}

// ---- bulk update ---------------------------------------------------------------

export type BulkUpdateRateGridInput = RateGridBulkUpdateRequest & {
  propertyId: string;
  context: UserContext;
  correlationId?: string;
  outbox?: RateGridOutbox;
};

/** Snapshot the bulk-op expansion needs: current base prices of the ops' window. */
async function loadBulkSnapshot(catalog: PropertyCatalog, ops: NonNullable<RateGridBulkUpdateRequest["ops"]>): Promise<BulkGridSnapshot> {
  const froms = ops.flatMap((o) => [o.scope.from, ...(o.price?.mode === "copyFrom" ? [o.price.fromDate] : [])]).sort();
  const tos = ops.flatMap((o) => [o.scope.to, ...(o.price?.mode === "copyFrom" ? [o.price.fromDate] : [])]).sort();
  const rows = await prisma.rateDay.findMany({
    where: { propertyId: catalog.propertyId, date: { gte: dayUtc(froms[0]!), lte: dayUtc(tos[tos.length - 1]!) } },
    select: { ratePlanId: true, roomTypeId: true, date: true, price: true, source: true, manuallyOverridden: true }
  });
  const cells = new Map<string, { basePrice: number | null; source: "manual" | "rms" | "derived" | "import"; manuallyOverridden: boolean }>();
  for (const r of rows) {
    cells.set(cellKey(r.ratePlanId, r.roomTypeId, isoDate(r.date)), {
      basePrice: Number(r.price),
      source: r.source === "rms" || r.source === "derived" || r.source === "import" ? r.source : "manual",
      manuallyOverridden: r.manuallyOverridden
    });
  }
  return {
    roomTypeIds: catalog.roomTypes.map((t) => t.id),
    ratePlanIds: catalog.plans.map((p) => p.id),
    inactivePlans: new Map([...catalog.inactivePlanById.values()].map((p) => [p.id, p.code])),
    derivedPlanIds: new Set(catalog.plans.filter((p) => p.parentRatePlanId).map((p) => p.id)),
    channelIds: [...catalog.channelIds],
    cells
  };
}

export async function bulkUpdateRateGrid(input: BulkUpdateRateGridInput): Promise<RateGridBulkUpdateResponse> {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  if (!input.propertyId) throw new BadRequestError("propertyId es obligatorio.");
  const body = parseOr400(bulkUpdateSchema, {
    cells: input.cells,
    ops: input.ops,
    reason: input.reason,
    publish: input.publish,
    clientRequestId: input.clientRequestId
  }, "bulk-update");
  const catalog = await loadPropertyCatalog(input.propertyId);

  const patches: EnginePatch[] = [];
  let skipped: RateGridBulkUpdateResponse["skipped"] = [];
  const warnings: string[] = [];
  let inactivePlanIds: string[] = [];
  let allScopesInactive = false;
  if (body.ops && body.ops.length > 0) {
    const expanded = expandBulkOps(body.ops, await loadBulkSnapshot(catalog, body.ops));
    patches.push(...expanded.patches);
    skipped = expanded.skipped;
    warnings.push(...expanded.warnings);
    inactivePlanIds = expanded.inactivePlanIds;
    allScopesInactive = expanded.allScopesInactive;
  }
  // Cells after ops on purpose: a manual cell edit wins over a bulk op on the same cell.
  if (body.cells) patches.push(...(body.cells as RateGridCellPatch[]));
  assertPatchBudget(patches.length, MAX_CELLS);
  if (patches.length === 0 && allScopesInactive && inactivePlanIds.length > 0) {
    // Every op named only soft-deleted plans: the same answer the `cells` path
    // gives (assertPatchIdsBelong) — «reactívalos», not «revisa el ámbito».
    const codes = inactivePlanIds.map((id) => catalog.inactivePlanById.get(id)?.code ?? id);
    const error = new BadRequestError(`Las operaciones referencian planes tarifarios inactivos (${codes.slice(0, 5).join(", ")}): reactívalos para editar sus celdas.`);
    error.details = { code: "INACTIVE_RATE_PLANS", ratePlanIds: inactivePlanIds.slice(0, 20), warnings, skipped: skipped.slice(0, 200) };
    throw error;
  }
  if (patches.length === 0) {
    // Nothing to apply (ops expanded to no cell): a no-op must not leave an
    // empty journal entry behind — say why instead.
    const error = new BadRequestError(
      `Las operaciones no afectan a ninguna celda: ${warnings.length > 0 ? warnings.slice(0, 3).join("; ") : "revisa el ámbito (fechas, tipos, planes) y que las celdas tengan tarifa base"}.`
    );
    error.details = { code: "NO_CELLS", warnings, skipped: skipped.slice(0, 200) };
    throw error;
  }
  if (patches.some((p) => p.restrictions && Object.keys(p.restrictions).length > 0)) {
    requirePermissions(input.context, ["revenue.manage_restrictions"]);
  }
  if (body.publish) {
    const unknown = body.publish.channelIds.filter((id) => !catalog.channelIds.has(id));
    if (unknown.length > 0) {
      const error = new BadRequestError("publish.channelIds contiene canales que no pertenecen a la propiedad.");
      error.details = { code: "UNKNOWN_IDS", channelIds: unknown };
      throw error;
    }
  }

  const result = await executeRateGridWrite({
    catalog,
    context: input.context,
    patches,
    reason: body.reason,
    status: "draft",
    clientRequestId: body.clientRequestId ?? null,
    correlationId: input.correlationId,
    skipped,
    warnings,
    conflictIfAllFail: true
  });
  const response = toWireResponse(result);

  if (body.publish && patches.length > 0) {
    if (result.replayed) {
      // The first attempt already enqueued its publish (its `queued` is not
      // part of the stored response): re-enqueueing would re-send every cell.
      response.warnings = [...(response.warnings ?? []), "petición repetida (clientRequestId ya procesado): los cambios y su publicación no se han vuelto a aplicar"];
      return response;
    }
    const dates = patches.map((p) => p.date).sort();
    const scope = derivePushScope(patches, catalog.childrenOf);
    const kinds = body.publish.kinds ?? scope.kinds;
    if (kinds.length === 0) {
      response.warnings = [...(response.warnings ?? []), "publicación no encolada: ninguna celda modificada afecta a tarifas, disponibilidad o restricciones"];
      return response;
    }
    const outbox = input.outbox ?? (await getRateGridOutbox());
    try {
      const pushed = await outbox.enqueueRateGridPush({
        propertyId: input.propertyId,
        from: dates[0]!,
        to: dates[dates.length - 1]!,
        channelIds: body.publish.channelIds,
        kinds,
        roomTypeIds: scope.roomTypeIds,
        ...(scope.ratePlanIds ? { ratePlanIds: scope.ratePlanIds } : {}),
        journalId: response.journalId,
        actorUserId: input.context.userId
      });
      response.queued = Object.fromEntries(Object.entries(pushed.byChannel).map(([id, v]) => [id, v.queued]));
      if (pushed.warnings.length > 0) response.warnings = [...(response.warnings ?? []), ...pushed.warnings];
    } catch (error) {
      // The cells are committed; a failing enqueue must not turn the save into a 500.
      response.warnings = [...(response.warnings ?? []), `publicación no encolada: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
  return response;
}

// ---- push / sync status -------------------------------------------------------------

export type PushRateGridInput = RateGridPushRequest & { propertyId: string; context: UserContext; outbox?: RateGridOutbox };

export async function pushRateGrid(input: PushRateGridInput): Promise<RateGridPushResponse> {
  requirePermissions(input.context, ["distribution.sync"]);
  const body = parseOr400(pushSchema, {
    from: input.from,
    to: input.to,
    channelIds: input.channelIds,
    ratePlanIds: input.ratePlanIds,
    roomTypeIds: input.roomTypeIds,
    kinds: input.kinds,
    journalId: input.journalId
  }, "push");
  const win = parseGridWindow({ from: body.from, to: body.to });
  const catalog = await loadPropertyCatalog(input.propertyId);
  const unknownChannels = body.channelIds.filter((id) => !catalog.channelIds.has(id));
  const unknownPlans = (body.ratePlanIds ?? []).filter((id) => !catalog.planById.has(id));
  const unknownTypes = (body.roomTypeIds ?? []).filter((id) => !catalog.roomTypes.some((t) => t.id === id));
  if (unknownChannels.length + unknownPlans.length + unknownTypes.length > 0) {
    const error = new BadRequestError("channelIds/ratePlanIds/roomTypeIds contienen ids que no pertenecen a la propiedad.");
    error.details = { code: "UNKNOWN_IDS", channelIds: unknownChannels, ratePlanIds: unknownPlans, roomTypeIds: unknownTypes };
    throw error;
  }
  if (body.journalId) {
    const journal = await prisma.rateChangeJournal.findFirst({ where: { id: body.journalId, propertyId: input.propertyId }, select: { id: true } });
    if (!journal) throw new NotFoundError("Entrada del historial de tarifas no encontrada.");
  }
  const outbox = input.outbox ?? (await getRateGridOutbox());
  return outbox.enqueueRateGridPush({
    propertyId: input.propertyId,
    from: win.from,
    to: win.to,
    channelIds: body.channelIds,
    kinds: body.kinds,
    ratePlanIds: body.ratePlanIds,
    roomTypeIds: body.roomTypeIds,
    journalId: body.journalId ?? null,
    actorUserId: input.context.userId
  });
}

export async function getRateGridSyncStatus(input: {
  propertyId: string;
  from?: unknown;
  to?: unknown;
  channelIds?: string[];
  outbox?: RateGridOutbox;
}): Promise<RateGridSyncStatusResponse> {
  const win = parseGridWindow({ from: input.from, to: input.to });
  const channels = await listGridChannels(input.propertyId, input.channelIds);
  if (input.channelIds && input.channelIds.length > 0 && channels.length !== new Set(input.channelIds).size) {
    const known = new Set(channels.map((c) => c.id));
    const error = new BadRequestError("channelIds contiene canales que no pertenecen a la propiedad.");
    error.details = { code: "UNKNOWN_IDS", channelIds: input.channelIds.filter((id) => !known.has(id)) };
    throw error;
  }
  const outbox = input.outbox ?? (await getRateGridOutbox());
  const full = await outbox.getCellSyncMap(input.propertyId, win.from, win.to);
  const allowed = input.channelIds && input.channelIds.length > 0 ? new Set(input.channelIds) : null;
  const filtered: CellSyncMap = {};
  for (const [key, byChannel] of Object.entries(full)) {
    const kept = allowed ? Object.fromEntries(Object.entries(byChannel).filter(([id]) => allowed.has(id))) : byChannel;
    if (Object.keys(kept).length > 0) filtered[key] = kept;
  }
  const cells = Object.entries(filtered)
    .map(([key, byChannel]) => {
      const [ratePlanId, roomTypeId, date] = key.split("|") as [string, string, string];
      return { ratePlanId, roomTypeId, date, byChannel };
    })
    .sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId) || a.ratePlanId.localeCompare(b.ratePlanId) || a.date.localeCompare(b.date));
  return { from: win.from, to: win.to, channels, cells, summary: summarizeSync(filtered) };
}

// ---- rederive ---------------------------------------------------------------------

/** Re-materialise a derived plan from its parent over a window (manual cells kept). */
export async function rederiveRatePlan(input: {
  propertyId: string;
  ratePlanId: string;
  context: UserContext;
  from?: unknown;
  to?: unknown;
  correlationId?: string;
}): Promise<RateGridBulkUpdateResponse> {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const win = parseGridWindow({ from: input.from, to: input.to });
  const catalog = await loadPropertyCatalog(input.propertyId);
  const plan = catalog.planById.get(input.ratePlanId);
  if (!plan) throw new NotFoundError("Plan de tarifas no encontrado.");
  if (!plan.parentRatePlanId || !catalog.planById.has(plan.parentRatePlanId)) {
    throw new BadRequestError("El plan no es derivado (sin parentRatePlanId activo): nada que rederivar.");
  }
  const parentRows = await prisma.rateDay.findMany({
    where: { propertyId: input.propertyId, ratePlanId: plan.parentRatePlanId, date: { gte: dayUtc(win.from), lte: dayUtc(win.to) } },
    select: { roomTypeId: true, date: true }
  });
  const patches: EnginePatch[] = parentRows
    .filter((r) => catalog.roomTypes.some((t) => t.id === r.roomTypeId))
    .map((r) => ({ ratePlanId: plan.parentRatePlanId!, roomTypeId: r.roomTypeId, date: isoDate(r.date), rematerializeOnly: true, onlyChildIds: [plan.id] }));
  const result = await executeRateGridWrite({
    catalog,
    context: input.context,
    patches,
    reason: `Rederivación de ${plan.code} desde ${catalog.planById.get(plan.parentRatePlanId)!.code} (${win.from}..${win.to})`,
    status: "draft",
    correlationId: input.correlationId,
    auditAction: "RATE_PLAN_REDERIVED",
    warnings: patches.length === 0 ? ["el plan padre no tiene tarifas en la ventana"] : undefined
  });
  return toWireResponse(result);
}
