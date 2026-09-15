// Channel mapping management — Prisma-backed.
//
// Rate grid v2 (lote api-channel-outbox): the canonical mapping is now PER
// PRODUCT — ChannelProductMapping (channel, roomType, ratePlan) →
// externalRoomCode + externalRateCode + pricingModel — because every OTA
// addresses ARI by (room, rate plan) and a room code alone cannot carry a
// derived plan or an occupancy pricing model. The v1 ChannelRoomMapping /
// ChannelRateMapping tables stay as READ-ONLY legacy (the hub screens still
// list them) and `migrateLegacyMappings` derives product mappings from their
// cross join. New code must read `loadProductMappingIndex`.
//
// Sprint 44: the OLD per-channel mapping endpoints in server.ts used the
// demoStore `createAdvancedRecord` stub, so mappings written through the UI were
// never visible to the aggregator (which reads real `ChannelRoomMapping` /
// `ChannelRateMapping` rows). Pushes then "failed silently" with
// "No room/rate mappings configured". This module is the real backing.
//
// SCHEMA NOTE — the spec talks about `externalRoomId` + `externalRoomCode`, but
// the Prisma schema only has `externalRoomCode` (canonical code, REQUIRED) and
// `externalRoomName` (optional descriptor). We map the spec's `externalRoomId`
// onto `externalRoomName` so both pieces of caller-supplied data survive a
// round-trip, and treat `externalRoomCode` as the canonical external id. The
// listings echo both back under the spec's field names so the UI/contract is
// stable regardless of the underlying column names.
//
// IDEMPOTENCY — the spec asks for upsert idempotency on (channelId, roomTypeId).
// The DB unique key is the wider (channelId, roomTypeId, externalRoomCode), so a
// raw Prisma `upsert` keyed on the compound unique would create a *second* row
// whenever the external code changes for the same (channel, roomType). We
// instead findFirst on (channelId, roomTypeId) and update-or-create, which keeps
// exactly one mapping per (channel, roomType) — re-mapping to a new external
// code edits the existing row instead of duplicating it.

import { prisma } from "@hotelos/database";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

export type RoomMappingDTO = {
  id: string;
  channelId: string;
  roomTypeId: string;
  roomTypeName: string | null;
  roomTypeCode: string | null;
  externalRoomId: string | null;
  externalRoomCode: string;
  status: string;
};

export type RateMappingDTO = {
  id: string;
  channelId: string;
  ratePlanId: string;
  ratePlanName: string | null;
  ratePlanCode: string | null;
  externalRateId: string | null;
  externalRateCode: string;
  status: string;
};

export type MappingCoverage = {
  channelId: string;
  roomTypesTotal: number;
  roomTypesMapped: number;
  ratePlansTotal: number;
  ratePlansMapped: number;
  complete: boolean;
};

async function channelOrThrow(channelId: string) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw new NotFoundError("Canal no encontrado.");
  return channel;
}

// ---------------------------------------------------------------- room mappings

export async function listRoomMappings(channelId: string): Promise<RoomMappingDTO[]> {
  const channel = await channelOrThrow(channelId);
  const [mappings, roomTypes] = await Promise.all([
    prisma.channelRoomMapping.findMany({ where: { channelId } }),
    prisma.roomType.findMany({ where: { propertyId: channel.propertyId } })
  ]);
  const byId = new Map(roomTypes.map((r) => [r.id, r] as const));
  return mappings
    .map((m) => {
      const rt = byId.get(m.roomTypeId);
      return {
        id: m.id,
        channelId: m.channelId,
        roomTypeId: m.roomTypeId,
        roomTypeName: rt?.name ?? null,
        roomTypeCode: rt?.code ?? null,
        externalRoomId: m.externalRoomName,
        externalRoomCode: m.externalRoomCode,
        status: m.status
      };
    })
    .sort((a, b) => (a.roomTypeName ?? "").localeCompare(b.roomTypeName ?? ""));
}

export async function upsertRoomMapping(input: {
  channelId: string;
  roomTypeId: string;
  externalRoomId?: string | null;
  externalRoomCode: string;
}): Promise<RoomMappingDTO> {
  const channel = await channelOrThrow(input.channelId);
  // Typed 4xx (not a bare Error → 500): the legacy hub routes still call this.
  if (!input.externalRoomCode || input.externalRoomCode.trim().length === 0) {
    throw new BadRequestError("externalRoomCode es obligatorio.");
  }
  const roomType = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
  if (!roomType || roomType.propertyId !== channel.propertyId) {
    throw new NotFoundError("Tipo de habitación no encontrado en la propiedad del canal.");
  }
  const externalRoomName = input.externalRoomId?.trim() ? input.externalRoomId.trim() : null;

  // Idempotent on (channelId, roomTypeId): one mapping per (channel, roomType).
  const existing = await prisma.channelRoomMapping.findFirst({
    where: { channelId: input.channelId, roomTypeId: input.roomTypeId }
  });
  const saved = existing
    ? await prisma.channelRoomMapping.update({
        where: { id: existing.id },
        data: { externalRoomCode: input.externalRoomCode.trim(), externalRoomName, status: "active" }
      })
    : await prisma.channelRoomMapping.create({
        data: {
          channelId: input.channelId,
          roomTypeId: input.roomTypeId,
          externalRoomCode: input.externalRoomCode.trim(),
          externalRoomName,
          status: "active"
        }
      });
  return {
    id: saved.id,
    channelId: saved.channelId,
    roomTypeId: saved.roomTypeId,
    roomTypeName: roomType.name,
    roomTypeCode: roomType.code,
    externalRoomId: saved.externalRoomName,
    externalRoomCode: saved.externalRoomCode,
    status: saved.status
  };
}

export async function deleteRoomMapping(id: string): Promise<{ id: string; deleted: boolean }> {
  const existing = await prisma.channelRoomMapping.findUnique({ where: { id } });
  if (!existing) return { id, deleted: false };
  await prisma.channelRoomMapping.delete({ where: { id } });
  return { id, deleted: true };
}

// ---------------------------------------------------------------- rate mappings

export async function listRateMappings(channelId: string): Promise<RateMappingDTO[]> {
  const channel = await channelOrThrow(channelId);
  const [mappings, ratePlans] = await Promise.all([
    prisma.channelRateMapping.findMany({ where: { channelId } }),
    prisma.ratePlan.findMany({ where: { propertyId: channel.propertyId } })
  ]);
  const byId = new Map(ratePlans.map((r) => [r.id, r] as const));
  return mappings
    .map((m) => {
      const rp = byId.get(m.ratePlanId);
      return {
        id: m.id,
        channelId: m.channelId,
        ratePlanId: m.ratePlanId,
        ratePlanName: rp?.name ?? null,
        ratePlanCode: rp?.code ?? null,
        externalRateId: m.externalRateName,
        externalRateCode: m.externalRateCode,
        status: m.status
      };
    })
    .sort((a, b) => (a.ratePlanName ?? "").localeCompare(b.ratePlanName ?? ""));
}

export async function upsertRateMapping(input: {
  channelId: string;
  ratePlanId: string;
  externalRateId?: string | null;
  externalRateCode: string;
}): Promise<RateMappingDTO> {
  const channel = await channelOrThrow(input.channelId);
  if (!input.externalRateCode || input.externalRateCode.trim().length === 0) {
    throw new BadRequestError("externalRateCode es obligatorio.");
  }
  const ratePlan = await prisma.ratePlan.findUnique({ where: { id: input.ratePlanId } });
  if (!ratePlan || ratePlan.propertyId !== channel.propertyId) {
    throw new NotFoundError("Plan de tarifas no encontrado en la propiedad del canal.");
  }
  const externalRateName = input.externalRateId?.trim() ? input.externalRateId.trim() : null;

  const existing = await prisma.channelRateMapping.findFirst({
    where: { channelId: input.channelId, ratePlanId: input.ratePlanId }
  });
  const saved = existing
    ? await prisma.channelRateMapping.update({
        where: { id: existing.id },
        data: { externalRateCode: input.externalRateCode.trim(), externalRateName, status: "active" }
      })
    : await prisma.channelRateMapping.create({
        data: {
          channelId: input.channelId,
          ratePlanId: input.ratePlanId,
          externalRateCode: input.externalRateCode.trim(),
          externalRateName,
          status: "active"
        }
      });
  return {
    id: saved.id,
    channelId: saved.channelId,
    ratePlanId: saved.ratePlanId,
    ratePlanName: ratePlan.name,
    ratePlanCode: ratePlan.code,
    externalRateId: saved.externalRateName,
    externalRateCode: saved.externalRateCode,
    status: saved.status
  };
}

export async function deleteRateMapping(id: string): Promise<{ id: string; deleted: boolean }> {
  const existing = await prisma.channelRateMapping.findUnique({ where: { id } });
  if (!existing) return { id, deleted: false };
  await prisma.channelRateMapping.delete({ where: { id } });
  return { id, deleted: true };
}

// -------------------------------------------------------------------- coverage

export async function mappingCoverage(channelId: string): Promise<MappingCoverage> {
  const channel = await channelOrThrow(channelId);
  const [roomTypes, ratePlans, roomMappings, rateMappings] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId: channel.propertyId, active: true } }),
    prisma.ratePlan.findMany({ where: { propertyId: channel.propertyId, active: true } }),
    prisma.channelRoomMapping.findMany({ where: { channelId } }),
    prisma.channelRateMapping.findMany({ where: { channelId } })
  ]);
  const roomTypeIds = new Set(roomTypes.map((r) => r.id));
  const ratePlanIds = new Set(ratePlans.map((r) => r.id));
  // Only count mappings that point at a still-active source room type / rate plan.
  const mappedRoomTypeIds = new Set(
    roomMappings.map((m) => m.roomTypeId).filter((id) => roomTypeIds.has(id))
  );
  const mappedRatePlanIds = new Set(
    rateMappings.map((m) => m.ratePlanId).filter((id) => ratePlanIds.has(id))
  );
  const roomTypesTotal = roomTypes.length;
  const roomTypesMapped = mappedRoomTypeIds.size;
  const ratePlansTotal = ratePlans.length;
  const ratePlansMapped = mappedRatePlanIds.size;
  const complete =
    roomTypesTotal > 0 &&
    ratePlansTotal > 0 &&
    roomTypesMapped >= roomTypesTotal &&
    ratePlansMapped >= ratePlansTotal;
  return {
    channelId,
    roomTypesTotal,
    roomTypesMapped,
    ratePlansTotal,
    ratePlansMapped,
    complete
  };
}

// ============================================================ product mappings (v2)

import { productKey, type PricingModelCode } from "./delivery.core.js";
export { productKey, type PricingModelCode };

export type ProductMappingDTO = {
  id: string;
  channelId: string;
  propertyId: string;
  roomTypeId: string;
  roomTypeCode: string | null;
  roomTypeName: string | null;
  ratePlanId: string;
  ratePlanCode: string | null;
  ratePlanName: string | null;
  externalRoomCode: string;
  externalRateCode: string;
  pricingModel: PricingModelCode;
  status: string;
  updatedAt: string;
  /** Non-blocking findings about the saved mapping (e.g. a Channex rate plan code shared by several room types). */
  warnings?: string[];
};

// The rules about shared external codes (what each provider does with a room
// or rate code used by two room types) are pure and live in mapping.core.ts;
// this file only fetches the rows.
import { addressesByRatePlanOnly, productMappingWarnings, sharedProductCodes, type SharedProductCodes } from "./mapping.core.js";
export { addressesByRatePlanOnly, type SharedProductCodes };

/** External room / rate codes of the channel used by more than one room type (active mappings). */
export async function sharedChannelProductCodes(channelId: string): Promise<SharedProductCodes> {
  const rows = await prisma.channelProductMapping.findMany({ where: { channelId, status: "active" }, select: { roomTypeId: true, externalRoomCode: true, externalRateCode: true, status: true } });
  return sharedProductCodes(rows);
}

export type ProductCoverage = {
  channelId: string;
  roomTypesActive: number;
  ratePlansDistributable: number;
  productsTotal: number;
  productsMapped: number;
  /** 0-100 */
  coveragePct: number;
  complete: boolean;
  missing: Array<{ roomTypeId: string; roomTypeCode: string; ratePlanId: string; ratePlanCode: string }>;
};

export type ProductMappingIndex = Map<string, Map<string, { id: string; roomTypeId: string; ratePlanId: string; externalRoomCode: string; externalRateCode: string; pricingModel: PricingModelCode }>>;

function asPricingModel(value: string): PricingModelCode {
  return value === "obp" || value === "los" ? value : "per_day";
}

/**
 * Distributable plans: active and not internal. `ratePlanType` "internal" /
 * "package" (and codes starting with "INT-") are house plans that never reach
 * an OTA; everything else (bar, nonrefundable, promo, corporate…) does.
 */
export function isDistributableRatePlan(plan: { active: boolean; ratePlanType: string; code: string }): boolean {
  if (!plan.active) return false;
  const type = plan.ratePlanType.toLowerCase();
  if (type === "internal" || type === "package" || type === "house") return false;
  return !plan.code.toUpperCase().startsWith("INT-");
}

/** channelId → (roomTypeId|ratePlanId) → mapping, for the given channels (active mappings only). */
export async function loadProductMappingIndex(channelIds: string[]): Promise<ProductMappingIndex> {
  const index: ProductMappingIndex = new Map();
  if (channelIds.length === 0) return index;
  const rows = await prisma.channelProductMapping.findMany({ where: { channelId: { in: channelIds }, status: "active" } });
  for (const row of rows) {
    let byProduct = index.get(row.channelId);
    if (!byProduct) {
      byProduct = new Map();
      index.set(row.channelId, byProduct);
    }
    byProduct.set(productKey(row.roomTypeId, row.ratePlanId), {
      id: row.id,
      roomTypeId: row.roomTypeId,
      ratePlanId: row.ratePlanId,
      externalRoomCode: row.externalRoomCode,
      externalRateCode: row.externalRateCode,
      pricingModel: asPricingModel(row.pricingModel)
    });
  }
  return index;
}

export async function listProductMappings(channelId: string): Promise<ProductMappingDTO[]> {
  const channel = await channelOrThrow(channelId);
  const [rows, roomTypes, ratePlans] = await Promise.all([
    prisma.channelProductMapping.findMany({ where: { channelId }, orderBy: [{ roomTypeId: "asc" }, { ratePlanId: "asc" }] }),
    prisma.roomType.findMany({ where: { propertyId: channel.propertyId }, select: { id: true, code: true, name: true } }),
    prisma.ratePlan.findMany({ where: { propertyId: channel.propertyId }, select: { id: true, code: true, name: true } })
  ]);
  const rt = new Map(roomTypes.map((r) => [r.id, r] as const));
  const rp = new Map(ratePlans.map((r) => [r.id, r] as const));
  return rows.map((m) => ({
    id: m.id,
    channelId: m.channelId,
    propertyId: m.propertyId,
    roomTypeId: m.roomTypeId,
    roomTypeCode: rt.get(m.roomTypeId)?.code ?? null,
    roomTypeName: rt.get(m.roomTypeId)?.name ?? null,
    ratePlanId: m.ratePlanId,
    ratePlanCode: rp.get(m.ratePlanId)?.code ?? null,
    ratePlanName: rp.get(m.ratePlanId)?.name ?? null,
    externalRoomCode: m.externalRoomCode,
    externalRateCode: m.externalRateCode,
    pricingModel: asPricingModel(m.pricingModel),
    status: m.status,
    updatedAt: m.updatedAt.toISOString()
  }));
}

export async function upsertProductMapping(input: {
  channelId: string;
  roomTypeId: string;
  ratePlanId: string;
  externalRoomCode: string;
  externalRateCode: string;
  pricingModel?: PricingModelCode;
  status?: "active" | "inactive";
}): Promise<ProductMappingDTO> {
  const channel = await channelOrThrow(input.channelId);
  const externalRoomCode = input.externalRoomCode.trim();
  const externalRateCode = input.externalRateCode.trim();
  if (!externalRoomCode) throw new BadRequestError("externalRoomCode es obligatorio.");
  if (!externalRateCode) throw new BadRequestError("externalRateCode es obligatorio.");
  const [roomType, ratePlan] = await Promise.all([
    prisma.roomType.findFirst({ where: { id: input.roomTypeId, propertyId: channel.propertyId }, select: { id: true } }),
    prisma.ratePlan.findFirst({ where: { id: input.ratePlanId, propertyId: channel.propertyId }, select: { id: true } })
  ]);
  if (!roomType) throw new NotFoundError("Tipo de habitación no encontrado en la propiedad del canal.");
  if (!ratePlan) throw new NotFoundError("Plan de tarifas no encontrado en la propiedad del canal.");
  const saved = await prisma.channelProductMapping.upsert({
    where: { channelId_roomTypeId_ratePlanId: { channelId: input.channelId, roomTypeId: input.roomTypeId, ratePlanId: input.ratePlanId } },
    update: { externalRoomCode, externalRateCode, pricingModel: input.pricingModel ?? "per_day", status: input.status ?? "active" },
    create: {
      propertyId: channel.propertyId,
      channelId: input.channelId,
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      externalRoomCode,
      externalRateCode,
      pricingModel: input.pricingModel ?? "per_day",
      status: input.status ?? "active"
    }
  });
  const list = await listProductMappings(input.channelId);
  const dto = list.find((m) => m.id === saved.id);
  if (!dto) throw new NotFoundError("Mapeo no encontrado tras guardarlo.");
  // Not a refusal (see mapping.core.ts): a room code shared with another type
  // is a warning for every provider, a shared rate code only for the
  // Channex-routed ones; readiness turns them into an error before the channel
  // goes live in mode `real`.
  const warnings = productMappingWarnings({ providerCode: channel.providerCode, roomTypeId: input.roomTypeId, externalRoomCode, externalRateCode, mappings: list });
  if (warnings.length > 0) dto.warnings = warnings;
  return dto;
}

export async function deleteProductMapping(id: string): Promise<{ id: string; deleted: boolean }> {
  const existing = await prisma.channelProductMapping.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { id, deleted: false };
  await prisma.channelProductMapping.delete({ where: { id } });
  return { id, deleted: true };
}

export async function productCoverage(channelId: string): Promise<ProductCoverage> {
  const channel = await channelOrThrow(channelId);
  const [roomTypes, ratePlans, mappings] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId: channel.propertyId, active: true }, select: { id: true, code: true } }),
    prisma.ratePlan.findMany({ where: { propertyId: channel.propertyId, active: true }, select: { id: true, code: true, active: true, ratePlanType: true } }),
    prisma.channelProductMapping.findMany({ where: { channelId, status: "active" }, select: { roomTypeId: true, ratePlanId: true } })
  ]);
  const distributable = ratePlans.filter(isDistributableRatePlan);
  const mapped = new Set(mappings.map((m) => productKey(m.roomTypeId, m.ratePlanId)));
  const missing: ProductCoverage["missing"] = [];
  let productsMapped = 0;
  for (const rt of roomTypes) {
    for (const rp of distributable) {
      if (mapped.has(productKey(rt.id, rp.id))) productsMapped++;
      else missing.push({ roomTypeId: rt.id, roomTypeCode: rt.code, ratePlanId: rp.id, ratePlanCode: rp.code });
    }
  }
  const productsTotal = roomTypes.length * distributable.length;
  return {
    channelId,
    roomTypesActive: roomTypes.length,
    ratePlansDistributable: distributable.length,
    productsTotal,
    productsMapped,
    coveragePct: productsTotal === 0 ? 0 : Math.round((productsMapped / productsTotal) * 100),
    complete: productsTotal > 0 && productsMapped >= productsTotal,
    missing
  };
}

/**
 * Derives product mappings from the legacy room × rate mappings (cross join):
 * every (room mapping, rate mapping) pair of the channel becomes one
 * ChannelProductMapping with the legacy external codes. Existing product
 * mappings are kept (never overwritten); returns how many were created.
 */
export async function migrateLegacyMappings(channelId: string): Promise<{ channelId: string; created: number; skippedExisting: number; pairs: number }> {
  const channel = await channelOrThrow(channelId);
  const [rooms, rates, existing] = await Promise.all([
    prisma.channelRoomMapping.findMany({ where: { channelId, status: "active" } }),
    prisma.channelRateMapping.findMany({ where: { channelId, status: "active" } }),
    prisma.channelProductMapping.findMany({ where: { channelId }, select: { roomTypeId: true, ratePlanId: true } })
  ]);
  const present = new Set(existing.map((m) => productKey(m.roomTypeId, m.ratePlanId)));
  let created = 0;
  let skippedExisting = 0;
  for (const room of rooms) {
    for (const rate of rates) {
      if (present.has(productKey(room.roomTypeId, rate.ratePlanId))) {
        skippedExisting++;
        continue;
      }
      await prisma.channelProductMapping.create({
        data: {
          propertyId: channel.propertyId,
          channelId,
          roomTypeId: room.roomTypeId,
          ratePlanId: rate.ratePlanId,
          externalRoomCode: room.externalRoomCode,
          externalRateCode: rate.externalRateCode,
          pricingModel: "per_day",
          status: "active"
        }
      });
      present.add(productKey(room.roomTypeId, rate.ratePlanId));
      created++;
    }
  }
  return { channelId, created, skippedExisting, pairs: rooms.length * rates.length };
}
