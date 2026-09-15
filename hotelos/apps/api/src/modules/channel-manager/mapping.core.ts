// Pure part of the product-mapping rules (rate grid v2). No database: the
// upsert warnings and the readiness `product_codes` check are built here from
// plain rows so they can be unit-tested (mapping.service.ts / readiness.service.ts
// only fetch the rows).
//
// What a shared external code means for each provider (how ARI is addressed):
//   · Channex-routed (channex, airbnb, vrbo, hotelbeds): rates and restrictions
//     go by `rate_plan_id`, availability by `room_type_id`. A Channex rate plan
//     belongs to ONE room type, so an externalRateCode shared by several room
//     types makes only the last price of a batch apply.
//   · Room-addressed (booking, expedia): everything goes by (InvTypeCode |
//     RoomType id, RatePlanCode | RatePlan id). A RatePlanCode shared across
//     rooms is normal there (the seed uses RP-<plan> for the four types).
//   · Every provider keys availability by the external ROOM code alone: an
//     externalRoomCode shared by two room types sends two counts to the same
//     room (and, room-addressed, two prices to the same product) — the last
//     value wins. That is the collision the hub let through silently.
//
// Neither collision is a refusal: the seeded sandbox channels must stay
// editable and a placeholder is replaced by the real id later; readiness turns
// them into an error before a channel goes live in mode `real`.

import { normalizeProviderCode } from "./adapters/index.js";

export type MappingCodeRow = { roomTypeId: string; roomTypeCode?: string | null; externalRoomCode: string; externalRateCode: string; status: string };

/** One external code used by more than one room type of the channel. */
export type SharedCode = { code: string; roomTypeIds: string[] };

export type SharedProductCodes = { roomCodes: SharedCode[]; rateCodes: SharedCode[] };

/**
 * Providers that address ARI by Channex rate plan id alone (a Channex rate
 * plan belongs to ONE room type): the same externalRateCode on two room types
 * of the channel would make the last value of the batch win on Channex.
 */
export function addressesByRatePlanOnly(providerCode: string): boolean {
  const code = normalizeProviderCode(providerCode);
  return code === "channex" || code === "airbnb" || code === "vrbo" || code === "hotelbeds";
}

/** Name of the system that receives the codes, for the hotelier's messages. */
export function providerLabelEs(providerCode: string): string {
  switch (normalizeProviderCode(providerCode)) {
    case "booking":
      return "Booking.com";
    case "expedia":
      return "Expedia";
    default:
      // channex itself and the OTAs routed through it: the codes are Channex ids.
      return "Channex";
  }
}

function sharedBy(rows: MappingCodeRow[], pick: (row: MappingCodeRow) => string): SharedCode[] {
  const byCode = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.status !== "active") continue;
    const set = byCode.get(pick(row)) ?? new Set<string>();
    set.add(row.roomTypeId);
    byCode.set(pick(row), set);
  }
  return [...byCode.entries()]
    .filter(([, roomTypes]) => roomTypes.size > 1)
    .map(([code, roomTypes]) => ({ code, roomTypeIds: [...roomTypes].sort() }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** External room / rate codes of a channel used by more than one room type (active mappings only). */
export function sharedProductCodes(rows: MappingCodeRow[]): SharedProductCodes {
  return { roomCodes: sharedBy(rows, (r) => r.externalRoomCode), rateCodes: sharedBy(rows, (r) => r.externalRateCode) };
}

/**
 * Non-blocking findings for a mapping just saved: the codes it shares with
 * OTHER room types of the same channel. `mappings` is the channel's current
 * list (the saved row included).
 */
export function productMappingWarnings(input: { providerCode: string; roomTypeId: string; externalRoomCode: string; externalRateCode: string; mappings: MappingCodeRow[] }): string[] {
  const others = input.mappings.filter((m) => m.status === "active" && m.roomTypeId !== input.roomTypeId);
  const names = (rows: MappingCodeRow[]) => rows.map((m) => m.roomTypeCode ?? m.roomTypeId).join(", ");
  const label = providerLabelEs(input.providerCode);
  const warnings: string[] = [];
  const sameRoom = others.filter((m) => m.externalRoomCode === input.externalRoomCode);
  if (sameRoom.length > 0) {
    warnings.push(
      `En ${label} cada código de habitación externo identifica un solo tipo de habitación: el código ${input.externalRoomCode} también está mapeado en ${names(sameRoom)}; la disponibilidad y las tarifas de ambos tipos irían a la misma habitación y solo se aplicaría el último valor enviado.`
    );
  }
  if (addressesByRatePlanOnly(input.providerCode)) {
    const sameRate = others.filter((m) => m.externalRateCode === input.externalRateCode);
    if (sameRate.length > 0) {
      warnings.push(
        `En Channex cada rate plan pertenece a un solo tipo de habitación: el código ${input.externalRateCode} también está mapeado en ${names(sameRate)}; con esos ids reales solo se aplicaría el último precio enviado.`
      );
    }
  }
  return warnings;
}
