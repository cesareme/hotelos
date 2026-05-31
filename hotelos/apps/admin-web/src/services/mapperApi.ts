import { apiRequest } from "./api-client";

export type MapperFile = { name: string; mimeType?: string; text?: string };

export type ProposedRoomType = { name: string; code?: string; baseOccupancy?: number; maxOccupancy?: number };
export type ProposedRoom = {
  number: string;
  floor?: string;
  building?: string;
  zone?: string;
  roomTypeName?: string;
  beds?: string;
  features?: string[];
  sellable?: boolean;
};

export type PropertyMapProposal = {
  source: "rules" | "ai" | "none";
  modelVersion: string;
  message?: string;
  buildings: string[];
  floors: string[];
  zones: string[];
  roomTypes: ProposedRoomType[];
  rooms: ProposedRoom[];
  spaces: string[];
  counts: { buildings: number; floors: number; zones: number; roomTypes: number; rooms: number; spaces: number };
};

export type ApplyResult = { roomTypesCreated: number; roomsCreated: number; roomsSkipped: number; notes: string[] };

export async function extractPropertyMap(propertyId: string, files: MapperFile[]): Promise<PropertyMapProposal> {
  return apiRequest<PropertyMapProposal>(`/properties/${propertyId}/mapper/extract`, { method: "POST", body: { files } });
}

export async function applyPropertyMap(propertyId: string, proposal: PropertyMapProposal): Promise<ApplyResult> {
  return apiRequest<ApplyResult>(`/properties/${propertyId}/mapper/apply`, { method: "POST", body: { proposal } });
}
