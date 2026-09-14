// Upsell catalogue client (Tanda 3 · CF-02). Staff routes over Prisma
// UpsellOffer — contract (H) of the Tanda 3 brief:
//   GET   /properties/:propertyId/upsell-offers      → { items: UpsellOfferRecord[] } (or a bare array)
//   POST  /properties/:propertyId/upsell-offers      → UpsellOfferRecord
//   PATCH /upsell-offers/:id                         → UpsellOfferRecord
// Prisma serialises Decimal `price` as a string, so `price` is normalised to a
// number here and never trusted as-is by the screens.

import { apiRequest } from "./api-client";

/** Row shape of Prisma `UpsellOffer` as returned by the API. */
export type UpsellOfferRecord = {
  id: string;
  propertyId: string;
  name: string;
  offerType: string;
  price: number | string | null;
  taxCode?: string | null;
  code?: string | null;
  description?: string | null;
  currency?: string | null;
  channel?: string | null;
  imageUrl?: string | null;
  taxCategory?: string | null;
  availabilityRulesJson?: unknown;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/** Normalised offer used by the UI (price always a number, currency always set). */
export type UpsellOffer = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  /** UI category — maps 1:1 to `UpsellOffer.offerType` in the API. */
  category: string;
  active: boolean;
  channel: string | null;
  imageUrl: string | null;
  taxCategory: string | null;
};

/** Body accepted by POST / PATCH. Uses API field names (`offerType`, not `category`). */
export type UpsellOfferInput = {
  name: string;
  offerType: string;
  price: number;
  currency?: string;
  code?: string | null;
  description?: string | null;
  channel?: string | null;
  imageUrl?: string | null;
  taxCategory?: string | null;
  taxCode?: string | null;
  active?: boolean;
  availabilityRulesJson?: Record<string, unknown>;
};

export type UpsellsDashboardKpis = {
  activeOffers: number;
  offersShown30d: number;
  conversions30d: number;
  conversionRatePct: number;
  revenueLift30dEur: number;
};

function toPrice(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeUpsellOffer(row: UpsellOfferRecord): UpsellOffer {
  return {
    id: row.id,
    code: row.code ?? "",
    name: row.name,
    description: row.description ?? null,
    price: toPrice(row.price),
    currency: (row.currency ?? "EUR").toUpperCase(),
    category: row.offerType,
    active: Boolean(row.active),
    channel: row.channel ?? null,
    imageUrl: row.imageUrl ?? null,
    taxCategory: row.taxCategory ?? null
  };
}

/** Maps the UI offer to the API body (category → offerType; empty strings → null). */
export function toUpsellOfferInput(offer: Omit<UpsellOffer, "id">): UpsellOfferInput {
  const clean = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    name: offer.name.trim(),
    offerType: offer.category,
    price: Number.isFinite(offer.price) ? offer.price : 0,
    currency: (offer.currency || "EUR").toUpperCase(),
    code: clean(offer.code),
    description: clean(offer.description),
    channel: clean(offer.channel),
    imageUrl: clean(offer.imageUrl),
    taxCategory: clean(offer.taxCategory),
    active: offer.active
  };
}

type ListResponse = { items: UpsellOfferRecord[] } | UpsellOfferRecord[];

export async function listUpsellOffers(propertyId: string): Promise<UpsellOffer[]> {
  const response = await apiRequest<ListResponse>(`/properties/${encodeURIComponent(propertyId)}/upsell-offers`);
  const rows = Array.isArray(response) ? response : response?.items ?? [];
  return rows.map(normalizeUpsellOffer);
}

export async function createUpsellOffer(propertyId: string, input: UpsellOfferInput): Promise<UpsellOffer> {
  const row = await apiRequest<UpsellOfferRecord>(`/properties/${encodeURIComponent(propertyId)}/upsell-offers`, {
    method: "POST",
    body: input
  });
  return normalizeUpsellOffer(row);
}

export async function patchUpsellOffer(offerId: string, patch: Partial<UpsellOfferInput>): Promise<UpsellOffer> {
  const row = await apiRequest<UpsellOfferRecord>(`/upsell-offers/${encodeURIComponent(offerId)}`, {
    method: "PATCH",
    body: patch
  });
  return normalizeUpsellOffer(row);
}

/** Read-only KPIs from GET /dashboards/upsells (last 30 days by default). */
export async function fetchUpsellsDashboardKpis(propertyId: string): Promise<UpsellsDashboardKpis> {
  const response = await apiRequest<{ kpis: UpsellsDashboardKpis }>("/dashboards/upsells", { query: { propertyId } });
  return response.kpis;
}
