// Channel room-type / rate-plan mapping management — Prisma-backed.
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
  if (!channel) throw new Error(`Channel not found: ${channelId}`);
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
  if (!input.externalRoomCode || input.externalRoomCode.trim().length === 0) {
    throw new Error("externalRoomCode is required.");
  }
  const roomType = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
  if (!roomType || roomType.propertyId !== channel.propertyId) {
    throw new Error(`Room type ${input.roomTypeId} does not belong to this channel's property.`);
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
    throw new Error("externalRateCode is required.");
  }
  const ratePlan = await prisma.ratePlan.findUnique({ where: { id: input.ratePlanId } });
  if (!ratePlan || ratePlan.propertyId !== channel.propertyId) {
    throw new Error(`Rate plan ${input.ratePlanId} does not belong to this channel's property.`);
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
