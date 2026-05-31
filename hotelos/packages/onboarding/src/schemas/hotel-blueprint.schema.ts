import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type HotelBlueprint = {
  organization: { name: string | null; legalName?: string | null };
  property: { name: string | null; address?: string | null; timezone?: string | null };
  legalProfile?: Record<string, unknown>;
  buildings: Array<{ name: string; floors: string[] }>;
  floors: Array<{ name: string; buildingName?: string | null; sortOrder?: number | null }>;
  zones: Array<{ name: string; floorName?: string | null; zoneType: string }>;
  rooms: Array<{ number: string; roomTypeCode?: string | null; floorName?: string | null; zoneName?: string | null }>;
  roomTypes: Array<{ code: string; name: string; maxOccupancy?: number | null }>;
  bedTypes: Array<{ code: string; name: string; capacity?: number | null }>;
  roomFeatures: string[];
  spaces: Array<{ name: string; spaceType: string; bookable?: boolean }>;
  inventoryResources: Array<{ name: string; resourceType: string; bookable: boolean; sellable: boolean }>;
  housekeepingSections: string[];
  maintenanceAreas: string[];
  assets: Array<Record<string, unknown>>;
  qrCodes: Array<Record<string, unknown>>;
};

export type HotelBlueprintSuggestion = OnboardingStructuredSuggestion<HotelBlueprint>;

export const HOTEL_BLUEPRINT_SCHEMA_NAME = "hotel-blueprint.schema";
