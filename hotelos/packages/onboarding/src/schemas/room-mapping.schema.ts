import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type RoomMappingTarget = {
  number: string | null;
  roomTypeCode: string | null;
  buildingName?: string | null;
  floorName?: string | null;
  zoneName?: string | null;
  inventoryResourceType: "room";
  sellable: boolean | null;
};

export type RoomMappingSuggestion = OnboardingStructuredSuggestion<RoomMappingTarget>;
