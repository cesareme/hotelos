import type { OnboardingStructuredSuggestion } from "./base-mapping.js";

export type ReservationMappingTarget = {
  code: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  guestIdentifier: string | null;
  roomTypeCode?: string | null;
  assignedRoomNumber?: string | null;
  channel?: string | null;
  balanceDue?: number | null;
  depositReference?: string | null;
};

export type ReservationMappingSuggestion = OnboardingStructuredSuggestion<ReservationMappingTarget>;
