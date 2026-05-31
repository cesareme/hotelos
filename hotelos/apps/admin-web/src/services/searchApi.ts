// Frontend client for the global cross-entity search endpoint.
import { apiRequest } from "./api-client";

export type SearchKind =
  | "reservation"
  | "guest"
  | "room"
  | "folio"
  | "invoice"
  | "property"
  | "rate_plan";

export type SearchHit = {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  screen: string;
  params?: Record<string, string>;
  score?: number;
};

export type SearchResponse = {
  items: SearchHit[];
  counts: Record<string, number>;
  took_ms: number;
};

export async function globalSearch(query: string, options?: { types?: SearchKind[]; propertyId?: string; limit?: number; signal?: AbortSignal }): Promise<SearchResponse> {
  const q = query.trim();
  if (!q) return { items: [], counts: {}, took_ms: 0 };
  const params = new URLSearchParams();
  params.set("q", q);
  if (options?.types?.length) params.set("types", options.types.join(","));
  if (options?.propertyId) params.set("propertyId", options.propertyId);
  if (options?.limit) params.set("limit", String(options.limit));
  return apiRequest<SearchResponse>(`/search?${params.toString()}`, { signal: options?.signal });
}

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  reservation: "Reservas",
  guest: "Huéspedes",
  room: "Habitaciones",
  folio: "Folios",
  invoice: "Facturas",
  property: "Propiedades",
  rate_plan: "Tarifas"
};
