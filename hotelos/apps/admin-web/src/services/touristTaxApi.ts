// Frontend client for tourist tax rates (Cataluña, Baleares, País Vasco, etc.)
// Backend: apps/api/src/routes/tourist-tax.routes.ts (real, registered).
import { apiRequest } from "./api-client";

export type TouristTaxRate = {
  id: string;
  country: string;
  ccaaCode: string; // CAT, BAL, EUSK, CAN, MAD, VAL, …
  municipality: string | null;
  establishmentClass: string;
  amountPerPersonNight: number; // Decimal in DB, number over the wire
  currency: string;
  validFrom: string;
  validUntil: string | null;
  maxNightsPerStay: number;
  highSeasonSurcharge: number | null;
  highSeasonFromMmdd: string | null;
  highSeasonUntilMmdd: string | null;
  taxableAgeFrom: number;
  legalSource: string | null;
};

export type CreateTouristTaxRatePayload = {
  ccaaCode: string;
  municipality?: string | null;
  establishmentClass: string;
  amountPerPersonNight: number;
  currency?: string;
  validFrom: string;
  validUntil?: string | null;
  maxNightsPerStay?: number;
  highSeasonSurcharge?: number | null;
  highSeasonFromMmdd?: string | null;
  highSeasonUntilMmdd?: string | null;
  taxableAgeFrom?: number;
  legalSource?: string | null;
};

export async function fetchTouristTaxRates(ccaaCode?: string): Promise<TouristTaxRate[]> {
  const qs = ccaaCode ? `?ccaaCode=${encodeURIComponent(ccaaCode)}` : "";
  const res = await apiRequest<{ items: TouristTaxRate[] }>(`/tourist-tax/rates${qs}`);
  return res.items;
}

export function createTouristTaxRate(payload: CreateTouristTaxRatePayload) {
  return apiRequest<TouristTaxRate>("/tourist-tax/rates", { method: "POST", body: payload });
}

export function seedTouristTaxRates() {
  return apiRequest<{ rates: number; exemptions: number }>("/tourist-tax/seed", { method: "POST" });
}
